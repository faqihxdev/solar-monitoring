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
