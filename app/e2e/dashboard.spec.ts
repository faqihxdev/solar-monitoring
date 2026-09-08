import { expect, test } from "@playwright/test";
import { fixturePayload, sampleReading } from "./fixtures";
import { inferEnergyFlows } from "../server/flows";

test("3D installation exposes every device, connections, and camera controls", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /shader|WebGLProgram/i.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.locator('.scene-viewport[data-ready="true"]'),
  ).toBeVisible();
  await expect(page.getByText("3.24 kW").first()).toBeVisible();
  await expect(page.locator(".device-label")).toHaveCount(5);
  await expect(page.locator(".battery-flow-detail")).toHaveText("1,420 W in");
  await page
    .locator(".device-label")
    .getByText("Home", { exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Home details" }),
  ).toContainText("1.82 kW");
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Perspective view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(
    page.getByRole("button", { name: "Top view", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.locator("#connection-details > div")).toHaveCount(4);
  await expect(page.locator("#connection-details")).toContainText(
    "Solar panels",
  );
  await page
    .locator(".device-label")
    .getByText("Battery", { exact: true })
    .click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Pause flow animation" }).click();
  await page
    .locator(".system-panel")
    .screenshot({ path: "test-results/installation.png" });
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`single-page dashboard remains responsive at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.locator('.scene-viewport[data-ready="true"]'),
    ).toBeVisible();
    await expect(page.locator(".device-label")).toHaveCount(5);
    const labelRects = await page
      .locator(".device-label")
      .evaluateAll((elements) =>
        elements.map((e) => {
          const r = e.getBoundingClientRect();
          return {
            text: e.textContent,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        }),
      );
    for (let i = 0; i < labelRects.length; i++)
      for (let j = i + 1; j < labelRects.length; j++) {
        const a = labelRects[i],
          b = labelRects[j];
        const overlaps =
          Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
          Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
        expect(overlaps, `${a.text} overlaps ${b.text} at ${width}px`).toBe(
          false,
        );
      }
    const labels = await page.locator(".device-label").evaluateAll((elements) =>
      elements.map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    expect(labels.every((r) => r.left >= 0 && r.right <= width)).toBe(true);
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toHaveCount(0);
    await expect(page.locator(".energy-overview")).toBeVisible();
    await expect(page.locator(".charts-section")).toBeVisible();
    await expect(page.locator(".daily-section")).toBeVisible();
    await expect(page.getByLabel("Target SOC", { exact: true })).toBeVisible();
    const sections = [
      ["overview", ".energy-overview"],
      ["history", ".charts-section"],
      ["daily", ".daily-section"],
      ["controls", ".controls-section"],
    ];
    for (const [name, selector] of sections) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (width === 375)
        await page
          .locator(selector)
          .screenshot({ path: `test-results/${name}-mobile.png` });
    }
  });
}

test("history dates stay synchronized and range selection returns to today", async ({
  page,
}) => {
  await page.goto("/#history");
  await page.getByRole("button", { name: "Previous day" }).first().click();
  const dates = await page.locator(".date-label").allTextContents();
  expect(dates[0]).toEqual(dates[1]);
  expect(dates[0]).not.toEqual("Today");
  await page.getByRole("button", { name: "1w", exact: true }).click();
  await expect(page.locator(".date-label").first()).toHaveText("Today");
  await expect(
    page.getByRole("button", { name: "1w", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("historical cards use the selected period, not the current reading", async ({
  page,
}) => {
  const today = new Date().toLocaleDateString("sv", {
    timeZone: "Asia/Jakarta",
  });
  const previousNoon = Date.parse(`${today}T12:00:00+07:00`) / 1000 - 86400;
  await page.route("**/api/history?**", (route) =>
    route.fulfill({
      json: {
        device_sn: "TEST",
        server_now: Date.now() / 1000,
        hours: 48,
        points: [
          sampleReading({
            polled_at: previousNoon,
            pv_power: 987,
            grid_voltage: 219,
          }),
        ],
      },
    }),
  );
  await page.goto("/#history");
  await page.getByRole("button", { name: "Previous day" }).first().click();
  await expect(
    page.getByText("Period-end values", { exact: false }),
  ).toBeVisible();
  const solar = page
    .locator(".chart-panel")
    .filter({ has: page.getByText("Solar generation", { exact: true }) });
  await expect(solar).toContainText("987");
  await expect(solar).not.toContainText("3240");
});

test("history failures stop showing a loading state and retry recovers", async ({
  page,
}) => {
  await page.route("**/api/history?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.route("**/api/voltage-history?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.goto("/#history");
  await expect(
    page.getByText("Some historical readings could not be loaded."),
  ).toBeVisible();
  await expect(
    page.getByText("Loading historical readings…"),
  ).not.toBeVisible();
  await page.unroute("**/api/history?**");
  await page.unroute("**/api/voltage-history?**");
  await page.getByRole("button", { name: "Retry history" }).click();
  await expect(
    page.getByText("Battery state of charge", { exact: true }),
  ).toBeVisible();
});

test("failed inverter writes preserve the draft for retry", async ({
  page,
}) => {
  await page.route("**/api/controls/bat_power_supply_value/write", (route) =>
    route.fulfill({
      json: {
        device_sn: "TEST",
        result: {
          field_id: "bat_power_supply_value",
          status: "failed",
          reason: "Verification failed",
          before: "12.6",
          requested: "12.8",
          verified: "12.6",
        },
      },
    }),
  );
  await page.goto("/#controls");
  const input = page.getByRole("spinbutton", {
    name: "A6 return to battery value",
  });
  await expect(input).toHaveValue("12.6");
  await input.fill("12.8");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Send A6 return to battery to inverter" })
    .click();
  await expect(
    page.getByText("A6 return to battery write failed: Verification failed"),
  ).toBeVisible();
  await expect(input).toHaveValue("12.8");
  await expect(
    page.getByRole("button", { name: "Send A6 return to battery to inverter" }),
  ).toBeEnabled();
});

test("phone landscape and larger text preserve layout and device selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 812, height: 375 });
  await page.goto("/");
  await expect(
    page.locator('.scene-viewport[data-ready="true"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.addStyleTag({ content: "html { font-size: 20px; }" });
  await page
    .locator(".device-label")
    .getByText("Battery", { exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Battery details" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("control drafts survive scrolling between sections and canceling a write sends nothing", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") writes.push(r.url());
  });
  await page.goto("/#controls");
  const field = page.getByRole("spinbutton", {
    name: "A6 return to battery value",
  });
  await expect(field).toHaveValue("12.6");
  await field.fill("12.8");
  await page.getByRole("link", { name: "Solar home overview" }).click();
  await page
    .locator(".device-label")
    .getByText("Inverter", { exact: true })
    .click();
  await page.getByRole("link", { name: "Go to controls" }).click();
  await expect(page.locator("#controls")).toBeInViewport();
  await expect(field).toHaveValue("12.8");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Send A6 return to battery to inverter" })
    .click();
  expect(writes).toEqual([]);
  await expect(field).toHaveValue("12.8");
});

test("stale and unmetered telemetry remains labeled accurately", async ({
  page,
}) => {
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        ...fixturePayload("/api/summary"),
        latest: sampleReading({
          polled_at: Date.now() / 1000 - 3600,
          battery_power: 0,
          battery_flow_unmetered: true,
          pv_power: 0,
          pv_to_battery_kw: 0,
          grid_to_battery_unmetered: true,
          working_state: "Mains state",
        }),
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Telemetry is delayed.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Last reading", { exact: true })).toBeVisible();
  await expect(page.locator(".live-badge")).not.toHaveClass(/is-live/);
  await expect(page.locator("#device-inspector")).toContainText("Unmetered");
  await expect(page.locator(".battery-flow-detail")).toHaveText("Unmetered in");
});

for (const width of [375, 1440]) {
  test(`estimated battery watts remain explicit and readable at ${width}px`, async ({
    page,
  }) => {
    const reading = sampleReading({
      battery_power: 0,
      pv_power: 234.26,
      load_power: 0.241,
      working_state: "Mains state",
      grid_power_effective: 0.241,
      grid_power_inferred: true,
    });
    await page.route("**/api/summary", (route) =>
      route.fulfill({
        json: {
          ...fixturePayload("/api/summary"),
          latest: { ...reading, ...inferEnergyFlows({ ...reading }) },
        },
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".battery-flow-detail")).toHaveText("≈ 234 W in");
    const label = page
      .locator(".device-label")
      .filter({ has: page.locator(".battery-flow-detail") });
    await expect(label).toContainText("Estimated power");
    await expect(page.locator("#device-inspector")).toContainText("≈ 234 W");
    await expect(page.locator("#device-inspector")).toContainText(
      "Conversion losses are not included",
    );
    const labelBounds = await label.boundingBox();
    const sceneBounds = await page.locator(".scene-viewport").boundingBox();
    expect(labelBounds!.x).toBeGreaterThanOrEqual(sceneBounds!.x);
    expect(labelBounds!.x + labelBounds!.width).toBeLessThanOrEqual(
      sceneBounds!.x + sceneBounds!.width,
    );
    await page.getByRole("button", { name: "Pause flow animation" }).click();
    await page.evaluate(() => document.fonts.ready);
    if (width === 1440) {
      // Compare projected anchors rather than the screenshot's fractional
      // bottom edge, which changes when clicking Reset scrolls the page.
      const anchors = () =>
        page
          .locator(".installation-leaders circle")
          .evaluateAll((dots) =>
            dots.map((dot) => [
              Number(dot.getAttribute("cx")),
              Number(dot.getAttribute("cy")),
            ]),
          );
      const initialAnchors = await anchors();
      await page.getByRole("button", { name: "Reset view" }).click();
      await expect.poll(anchors).toEqual(initialAnchors);
    }
    await page
      .locator(".system-panel")
      .screenshot({ path: `test-results/battery-estimate-${width}.png` });
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    const connection = page
      .locator("#connection-details > div")
      .filter({ hasText: "Battery DC" });
    await expect(connection).toContainText("≈ 234 W");
    await expect(connection).toContainText("Estimated");
  });
}

test("missing telemetry shows unknown readings and history errors can recover", async ({
  page,
}) => {
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: { ...fixturePayload("/api/summary"), latest: null },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Waiting for the first device reading.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".metric-main strong").first()).toHaveText("—");
  await page.route("**/api/daily?**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page
    .locator(".daily-section")
    .getByRole("button", { name: "Previous day" })
    .click();
  await expect(page.getByText("Daily energy is unavailable")).toBeVisible();
  await page.unroute("**/api/daily?**");
  await page.getByRole("button", { name: "Retry daily energy" }).click();
  await expect(page.getByText("Daily energy is unavailable")).not.toBeVisible();
});

test("reduced motion and WebGL failure retain usable device information", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pause flow animation" }),
  ).toBeDisabled();
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = function () {
      return null;
    };
  });
  await page.reload();
  await expect(page.getByText("3D view unavailable")).toBeVisible();
  await page
    .locator(".device-picker")
    .getByRole("button", { name: "Inverter", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Inverter details" }),
  ).toBeVisible();
});

for (const width of [375, 1440]) {
  test(`small inferred battery discharge is visible at ${width}px`, async ({
    page,
  }) => {
    const reading = sampleReading({
      battery_status: 1,
      battery_power: 0,
      pv_power: 606,
      load_power: 0.609,
    });
    await page.route("**/api/summary", (route) =>
      route.fulfill({
        json: {
          ...fixturePayload("/api/summary"),
          latest: { ...reading, ...inferEnergyFlows(reading) },
        },
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".battery-flow-detail")).toHaveText("≈ 3 W out");
    await expect(page.locator("#device-inspector")).toContainText("≈ 3 W");
    await page.getByRole("button", { name: "Pause flow animation" }).click();
    await page
      .locator(".system-panel")
      .screenshot({ path: `test-results/small-battery-flow-${width}.png` });
  });
}

test("grid charging with unknown watts exposes its known minimum", async ({
  page,
}) => {
  const reading = sampleReading({
    working_state: "Mains state",
    battery_power: 0,
    pv_power: 0,
    load_power: 0.5,
  });
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        ...fixturePayload("/api/summary"),
        latest: { ...reading, ...inferEnergyFlows(reading) },
      },
    }),
  );
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/");
  const gridLabel = page
    .locator(".device-label")
    .filter({ hasText: "Grid / PLN" });
  await expect(gridLabel).toContainText("≥ 500 W");
  await expect(gridLabel).toContainText("Estimated minimum");
  await gridLabel.click();
  await expect(page.locator("#device-inspector")).toContainText(
    "Additional grid charging is unmetered",
  );
  const bounds = await gridLabel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
});

test("cable light streaks move and the pause button freezes them", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.locator('.scene-viewport[data-ready="true"]'),
  ).toBeVisible();
  const canvas = page.locator(".scene-viewport canvas");
  const first = await canvas.screenshot({
    path: "test-results/flow-moving.png",
  });
  await page.waitForTimeout(450);
  const second = await canvas.screenshot();
  expect(first.equals(second)).toBe(false);
  await page.getByRole("button", { name: "Pause flow animation" }).click();
  await expect(page.locator(".scene-viewport")).toHaveAttribute(
    "data-motion",
    "false",
  );
  const paused = await canvas.screenshot();
  await page.waitForTimeout(450);
  expect(paused.equals(await canvas.screenshot())).toBe(true);
});
