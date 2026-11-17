import { expect, test } from "./fixtures";

test.describe("Ledelse", () => {
  test("the month picker moves the report to another month", async ({ page }) => {
    // The default is the newest finished month, which moves with the date.
    await page.goto("/ledelse");
    const picker = page.getByRole("combobox", { name: "Måned" });
    const initial = (await picker.innerText()).trim();
    await expect(page.getByRole("heading", { name: `Nøgletal, ${initial.toLowerCase()}` })).toBeVisible();

    await picker.click();
    const other = page.getByRole("option").filter({ hasNotText: initial }).first();
    const label = (await other.innerText()).trim();
    await other.click();
    await expect(page).toHaveURL(/[?&]maaned=\d{4}-\d{2}/);
    await expect(picker).toHaveText(label);
    // The running month's option reads "November 2026 (i gang)".
    const month = label.replace(/\s*\(.*\)$/, "").toLowerCase();
    await expect(page.getByRole("heading", { name: new RegExp(`^Nøgletal, ${month}`) })).toBeVisible();
  });

  test("one Hent menu holds every file of the report", async ({ page }) => {
    await page.goto("/ledelse");
    await page.getByRole("button", { name: "Hent" }).click();
    const menu = page.getByRole("menu", { name: "Hent" });
    await expect(menu.getByRole("menuitem", { name: "Månedsrapport (Excel)" })).toHaveAttribute(
      "href",
      /^\/api\/export\/xlsx\?report=management_kpis/
    );
    await expect(menu.getByRole("menuitem", { name: "Månedsrapport (PDF)" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Gennemløbstid pr. måned (Excel)" })).toBeVisible();
  });

  test("notes are saved", async ({ page }) => {
    const point = `E2E punkt ${Date.now()}`;
    await page.goto("/ledelse");
    await page.getByRole("button", { name: "Rediger noter" }).click();
    await page.getByRole("textbox", { name: "Det vigtigste" }).fill(point);
    await page.getByRole("textbox", { name: "Til beslutning" }).fill("E2E beslutning");
    await page.getByRole("button", { name: "Gem noter" }).click();
    await expect(page.getByRole("button", { name: "Rediger noter" })).toBeVisible();
    await expect(page.getByText(point)).toBeVisible();

    await page.reload();
    await expect(page.getByText(point)).toBeVisible();
  });
});
