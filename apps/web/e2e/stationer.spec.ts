import { expect, test } from "./fixtures";

test.describe("Stationer", () => {
  test("day view shows the station table", async ({ page }) => {
    await page.goto("/stationer");
    await expect(page.getByRole("heading", { level: 1, name: "Stationer" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Alle tal" })).toBeVisible();
    const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Gennem i dag" }) });
    const rows = table.getByRole("row");
    await expect(rows.filter({ hasText: "Station 10" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Station 70" }).first()).toBeVisible();
  });

  test("switches to the period view", async ({ page }) => {
    await page.goto("/stationer");
    await page.getByRole("navigation", { name: "Visning" }).getByRole("button", { name: "Periode" }).click();
    await expect(page).toHaveURL(/[?&]view=period/);
    await expect(page.getByRole("textbox", { name: "Fra" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Til" })).toBeVisible();
  });

  test("opens a station detail page", async ({ page }) => {
    await page.goto("/stationer");
    await page.getByRole("region", { name: "Stationer på dagen" }).getByRole("link", { name: /^Station 30 / }).click();
    await expect(page).toHaveURL(/\/stationer\/3(\?|$)/);
    await expect(page.getByRole("heading", { level: 1, name: "Station 30" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /uge for uge/ })).toBeVisible();
  });
});
