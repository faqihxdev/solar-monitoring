import { expect, test } from "@playwright/test";

test("dashboard loads every device without script or shader errors", async ({
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
  await expect(page.locator(".device-label")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("a read-only inverter shows settings without writes or automation", async ({
  page,
}) => {
  const automationRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/automation")) automationRequests.push(r.url());
  });
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: {
        ...config,
        inverter: {
          id: "growatt",
          name: "Growatt",
          writes: false,
          automation: false,
          battery_nominal_voltage: 51.2,
          soc_curve: [
            [40, 0],
            [51.2, 20],
            [53.6, 90],
            [58.4, 100],
          ],
        },
      },
    });
  });
  await page.goto("/#controls");
  await expect(
    page.getByRole("heading", { name: "Device settings" }),
  ).toBeVisible();
  await expect(
    page.getByText("Growatt settings are read-only here"),
  ).toBeVisible();
  await expect(page.getByText("Battery charge target")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Send / })).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Read A6 return to battery from inverter",
    }),
  ).toBeVisible();
  expect(automationRequests).toEqual([]);
});

test("canceling an inverter write sends nothing to the device", async ({
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
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Send A6 return to battery to inverter" })
    .click();
  expect(writes).toEqual([]);
  await expect(field).toHaveValue("12.8");
});
