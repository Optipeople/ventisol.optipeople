import { expect, test } from "./fixtures";

test.describe("Overblik", () => {
  test("shows the KPI tiles and the lead time chart", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Overblik" })).toBeVisible();

    const today = page.getByRole("region", { name: "I dag" });
    for (const term of ["Ordrer i gang", "Pakket i dag", "Elementer igennem i dag", "Stationer i gang nu"]) {
      await expect(today.getByRole("term").filter({ hasText: term })).toBeVisible();
    }
    for (const kpi of ["Leveret til tiden", "Ordrer pakket"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${kpi}:`) })).toBeVisible();
    }

    const chart = page.getByRole("region", { name: "Gennemløbstid pr. ordre, uge for uge" });
    // The chart draws its bars as plain elements and carries a screen reader
    // table with one row per week.
    await expect(chart.getByText(/^Uge \d+$/).first()).toBeVisible();
    const bars = chart.getByRole("table", { name: "Gennemløbstid pr. ordre, arbejde og ventetid" });
    expect(await bars.locator("tbody tr").count()).toBeGreaterThan(1);
  });

  test("a period preset sets from and to in the URL", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Sidste måned" }).click();
    await expect(page).toHaveURL(/[?&]from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByRole("textbox", { name: "Fra" })).toHaveValue(/^01-/);
  });

  test("the clock toggle sets clock in the URL", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Tid" }).getByRole("button", { name: "Hele døgnet" }).click();
    await expect(page).toHaveURL(/[?&]clock=wall/);
    await page.getByRole("navigation", { name: "Tid" }).getByRole("button", { name: "Arbejdstid" }).click();
    await expect(page).toHaveURL(/[?&]clock=working/);
  });
});
