import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Order numbers of the table's body rows, top to bottom. */
async function orderNumbers(page: Page): Promise<number[]> {
  const cells = page.getByRole("table").locator("tbody tr td:first-child");
  return (await cells.allInnerTexts()).map((t) => Number.parseInt(t, 10));
}

test.describe("Ordrer", () => {
  test("in progress tab lists orders", async ({ page }) => {
    await page.goto("/ordrer");
    await expect(page.getByRole("heading", { level: 2, name: "Ordrer i gang nu" })).toBeVisible();
    expect((await orderNumbers(page)).length).toBeGreaterThan(0);
  });

  test("the clock toggle shows the clock in use and keeps the choice in the URL", async ({ page }) => {
    await page.goto("/ordrer");
    const clock = page.getByRole("navigation", { name: "Tid" });
    await expect(clock.getByRole("button", { name: "Arbejdstid" })).toBeVisible();
    await expect(page.getByText("Som indstillet")).toHaveCount(0);
    await clock.getByRole("button", { name: "Hele døgnet" }).click();
    await expect(page).toHaveURL(/[?&]clock=wall/);
    await expect(page.getByRole("heading", { level: 2, name: "Ordrer i gang nu" })).toBeVisible();
  });

  test("search narrows the list and is kept in the URL", async ({ page }) => {
    await page.goto("/ordrer?view=finished");
    const search = page.getByLabel("Søg", { exact: true });
    await search.fill("Egholm");
    await search.press("Enter");
    await expect(page).toHaveURL(/[?&]q=Egholm/);
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows.first()).toContainText("Egholm");
    for (const text of await rows.allInnerTexts()) expect(text).toContain("Egholm");
  });

  test("finished tab sorts and pages through the URL", async ({ page }) => {
    await page.goto("/ordrer");
    await page.getByRole("navigation", { name: "Visning" }).getByRole("button", { name: "Afsluttede" }).click();
    await expect(page).toHaveURL(/[?&]view=finished/);
    await expect(page.getByRole("heading", { level: 2, name: "Afsluttede ordrer" })).toBeVisible();

    await page.getByRole("columnheader", { name: "Ordre" }).getByRole("link").click();
    await expect(page).toHaveURL(/[?&]sort=order/);
    await expect(page).toHaveURL(/[?&]dir=asc/);
    await expect(async () => {
      const numbers = await orderNumbers(page);
      expect(numbers.length).toBeGreaterThan(1);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }).toPass();
    const firstPage = await orderNumbers(page);

    await page.getByRole("navigation", { name: "Sider" }).getByRole("button", { name: "Side 2" }).click();
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(page).toHaveURL(/[?&]sort=order/);
    await expect(page.getByText(/^51 til \d+ af \d+ ordrer$/)).toBeVisible();
    const secondPage = await orderNumbers(page);
    expect(secondPage[0]).toBeGreaterThan(firstPage[firstPage.length - 1]);
  });

  test("an order page shows the route and the deviation notes", async ({ page }) => {
    await page.goto("/ordrer?view=finished");
    const row = page.getByRole("table").locator("tbody tr").first();
    const orderNo = (await row.locator("td").first().innerText()).trim();
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/ordre/${orderNo}(\\?|$)`));
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^Ordre ${orderNo}`) })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ruten gennem fabrikken" })).toBeVisible();
    await expect(page.getByText("Montage", { exact: true }).first()).toBeVisible();
    // The steps as a table are closed until asked for.
    const stepsHeader = page.getByRole("columnheader", { name: "Kilde" });
    await expect(stepsHeader).toBeHidden();
    await page.getByText("Vis trinene som tabel").click();
    await expect(stepsHeader).toBeVisible();
    await expect(page.getByRole("region", { name: "Afvigelser" })).toBeVisible();
  });

  // The sample PDFs live in orderdocs/ at the repo root, which is not in git:
  // the test runs where they exist (a developer machine) and is skipped in CI.
  test("the PDF viewer draws the production list", async ({ page }) => {
    const sample = resolve(process.cwd(), "..", "..", "orderdocs", "58721_20261022.pdf");
    test.skip(!existsSync(sample), "orderdocs/58721_20261022.pdf is not here (it is not in git)");
    await page.goto("/ordre/58721");
    await expect(page.getByRole("heading", { level: 1, name: "Ordre 58721" })).toBeVisible();
    const firstPage = page.getByRole("img", { name: /58721_20261022\.pdf, side 1 af/ });
    await expect(firstPage).toBeVisible({ timeout: 60_000 });
    expect(await firstPage.evaluate((el) => el.tagName)).toBe("CANVAS");
    const width = await firstPage.evaluate((el) => (el as HTMLCanvasElement).width);
    expect(width).toBeGreaterThan(100);
  });

  test("the Excel export answers with an xlsx file", async ({ page, request }) => {
    await page.goto("/ordrer?view=finished");
    const href = await page.getByRole("link", { name: "Download Excel" }).getAttribute("href");
    expect(href).toContain("/api/export/xlsx");
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    const body = await res.body();
    // An xlsx file is a zip archive.
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test("/periode redirects to /ordrer", async ({ page, request }) => {
    const res = await request.get("/periode?fra=2026-10-01&til=2026-10-31", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toMatch(/\/ordrer\?/);
    await page.goto("/periode");
    await expect(page).toHaveURL(/\/ordrer(\?|$)/);
    await expect(page.getByRole("heading", { level: 1, name: "Ordrer" })).toBeVisible();
  });
});
