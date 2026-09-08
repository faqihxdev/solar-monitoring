import { expect, test, type Page } from "@playwright/test";
import { fixturePayload, sampleReading } from "./fixtures";

async function expectMovingFlow(page: Page) {
  const canvas = page.locator(".scene-viewport canvas");
  const first = await canvas.screenshot();
  await page.waitForTimeout(400);
  expect(first.equals(await canvas.screenshot())).toBe(false);
}

test("leader lines use the rendered camera throughout a drag", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.locator('.scene-viewport[data-ready="true"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause flow animation" }).click();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find((entry) => /\/deps\/three\.js\?/.test(entry.name))?.name;
    if (!url) throw new Error("Three module was not loaded");
    const { Vector3 } = (await import(url)) as typeof import("three");
    const project = Vector3.prototype.project;
    const errors: number[] = [];
    Object.assign(window, { projectionErrors: errors });
    Vector3.prototype.project = function (camera) {
      const updated = camera.clone();
      updated.updateMatrixWorld();
      const expected = project.call(this.clone(), updated);
      const actual = project.call(this, camera);
      errors.push(actual.distanceTo(expected));
      return actual;
    };
  });
  const canvas = page.locator(".scene-viewport canvas");
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width * 0.55;
  const y = bounds.y + bounds.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y + 45, { steps: 12 });
  await page.mouse.move(x - 75, y - 30, { steps: 18 });
  await page.mouse.up();
  const errors = await page.evaluate(
    () => (window as Window & { projectionErrors: number[] }).projectionErrors,
  );
  expect(errors.length).toBeGreaterThanOrEqual(10);
  expect(Math.max(...errors)).toBeLessThan(0.000001);
});

test("delayed readings keep their flow animated", async ({ page }) => {
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        ...fixturePayload("/api/summary"),
        latest: sampleReading({ polled_at: Date.now() / 1000 - 3600 }),
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.locator('.scene-viewport[data-ready="true"]'),
  ).toBeVisible();
  await expect(page.locator(".live-badge")).not.toHaveClass(/is-live/);
  await expectMovingFlow(page);
  await page.getByRole("button", { name: "Pause flow animation" }).click();
  const canvas = page.locator(".scene-viewport canvas");
  const paused = await canvas.screenshot();
  await page.waitForTimeout(400);
  expect(paused.equals(await canvas.screenshot())).toBe(true);
});

test("cached flow survives polling and API errors, then takes the recovered reading", async ({
  page,
}) => {
  let phase: "initial" | "pending" | "offline" | "recovered" = "initial";
  let releasePoll!: () => void;
  let startedPoll!: () => void;
  const pending = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const started = new Promise<void>((resolve) => {
    startedPoll = resolve;
  });
  const initial = sampleReading();
  await page.route("**/api/summary", async (route) => {
    if (phase === "pending") {
      startedPoll();
      await pending;
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
    } else if (phase === "offline") {
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
    } else {
      await route.fulfill({
        json: {
          ...fixturePayload("/api/summary"),
          latest:
            phase === "initial"
              ? initial
              : sampleReading({
                  pv_power: 606,
                  load_power: 0.609,
                  battery_power: 0,
                  battery_status: 1,
                }),
        },
      });
    }
  });
  await page.goto("/");
  await expect(
    page.locator('.scene-viewport[data-ready="true"]'),
  ).toBeVisible();
  phase = "pending";
  await started;
  await expect(page.locator(".battery-flow-detail")).toHaveText("1,420 W in");
  await expectMovingFlow(page);
  phase = "offline";
  releasePoll();
  await expect(page.locator(".connection-status")).toHaveText("Offline", {
    timeout: 15000,
  });
  await expect(page.locator(".live-badge")).not.toHaveClass(/is-live/);
  await expect(page.locator(".battery-flow-detail")).toHaveText("1,420 W in");
  await expectMovingFlow(page);
  phase = "recovered";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".connection-status")).toHaveText("Connected");
  await expect(page.locator(".battery-flow-detail")).toHaveText("≈ 3 W out");
  await expect(page.locator(".live-badge")).toHaveClass(/is-live/);
});

test("local clock and update age tick visibly at phone and desktop widths", async ({
  page,
}) => {
  const now = Date.parse("2026-09-08T08:00:00Z");
  await page.clock.setFixedTime(now);
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        ...fixturePayload("/api/summary"),
        latest: sampleReading({ polled_at: now / 1000 - 20 }),
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".local-clock")).toHaveText("15:00:00 GMT+7");
  await expect(page.locator(".last-update")).toHaveText("Updated 20s ago");
  await page.clock.setFixedTime(now + 4000);
  await expect(page.locator(".local-clock")).toHaveText("15:00:04 GMT+7");
  await expect(page.locator(".last-update")).toHaveText("Updated 24s ago");
  await expect(page.locator(".last-update")).toHaveAttribute("title", /GMT\+7/);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".local-clock")).toBeInViewport();
    await expect(page.locator(".last-update")).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 375 || width === 1440) {
      await page.screenshot({
        path: `test-results/clean-overview-${width}.png`,
      });
    }
  }
  for (const filler of [
    "A closer look at what powers your home.",
    "Residential system",
    "Your connected home",
    "3D view",
    "Production and use, day by day.",
  ]) {
    await expect(page.getByText(filler, { exact: true })).toHaveCount(0);
  }
});
