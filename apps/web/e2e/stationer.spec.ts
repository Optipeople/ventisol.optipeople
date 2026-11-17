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
    // Status, in progress and missing scan-outs are on the tiles, not in the day table.
    await expect(table.getByRole("columnheader", { name: "Status" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Download Excel" })).toBeVisible();
  });

  test("the headline counts the stations when it would name more than three", async ({ page }) => {
    await page.goto("/stationer");
    const headline = page.getByRole("region", { name: "Stationer på dagen" }).getByRole("heading", { level: 2 });
    await expect(headline).toHaveText(/afviger fra det normale|Alle stationer kører normalt/);
    const names = (await headline.innerText()).match(/Station \d+/g) ?? [];
    expect(names.length).toBeLessThanOrEqual(3);
  });

  test("switches to the period view", async ({ page }) => {
    await page.goto("/stationer");
    await page.getByRole("navigation", { name: "Visning" }).getByRole("button", { name: "Periode" }).click();
    await expect(page).toHaveURL(/[?&]view=period/);
    // The date range field, not the Periode pill beside it.
    await expect(page.getByRole("button", { name: /^Periode \d/ })).toBeVisible();
  });

  test("opens a station detail page", async ({ page }) => {
    await page.goto("/stationer");
    await page.getByRole("region", { name: "Stationer på dagen" }).getByRole("link", { name: /^Station 30 / }).click();
    await expect(page).toHaveURL(/\/stationer\/3(\?|$)/);
    await expect(page.getByRole("heading", { level: 1, name: "Station 30" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /uge for uge/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download 12 uger (Excel)" })).toBeVisible();
  });

  test("the weeks table is folded away under the chart", async ({ page }) => {
    await page.goto("/stationer/2");
    const weeks = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Uge" }) });
    await expect(weeks).toBeHidden();
    await page.getByText("Vis ugerne som tabel").click();
    await expect(weeks).toBeVisible();
  });

  test("a station without data shows one empty state", async ({ page }) => {
    await page.goto("/stationer/20");
    await expect(page.getByRole("heading", { level: 1, name: "Station nr. 20" })).toBeVisible();
    await expect(page.getByText("Ingen passager de 12 uger op til denne dag")).toBeVisible();
    // Only the status tag in the header says it, not tiles and cards.
    await expect(page.getByText("Ingen data endnu")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /uge for uge/ })).toHaveCount(0);
    await expect(page.getByLabel("Dato", { exact: true })).toBeVisible();
  });
});
