import { expect, test } from "./fixtures";

const SECTIONS = [
  ["Brugere", "/indstillinger/brugere"],
  ["Stationer", "/indstillinger/stationer"],
  ["Elementtyper", "/indstillinger/elementtyper"],
  ["Tider", "/indstillinger/tider"],
  ["Kalender", "/indstillinger/kalender"],
  ["Grænseværdier", "/indstillinger/graensevaerdier"],
  ["Synkronisering", "/indstillinger/synkronisering"],
  ["Hændelseslog", "/indstillinger/log"],
] as const;

test.describe("Indstillinger", () => {
  test("each section opens", async ({ page }) => {
    await page.goto("/indstillinger");
    const nav = page.getByRole("navigation", { name: "Indstillinger" });
    for (const [name, path] of SECTIONS) {
      await nav.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("main").getByRole("heading", { level: 2 }).first()).toBeVisible();
      await expect(page.getByText(/Noget gik galt|Application error/)).toHaveCount(0);
    }
  });

  test("creates and edits a station", async ({ page }) => {
    // A fresh number each run: a station can never be deleted again.
    const stationNo = String(9000 + Math.floor(Math.random() * 999));
    const name = `E2E station ${stationNo}`;
    await page.goto("/indstillinger/stationer");

    // The form is a dialog, opened from the button over the table.
    await page.getByRole("button", { name: "Tilføj station" }).click();
    const form = page.getByRole("dialog", { name: "Tilføj station" });
    await form.getByRole("textbox", { name: "Stationsnr." }).fill(stationNo);
    await form.getByRole("textbox", { name: "Navn", exact: true }).fill(name);
    await form.getByRole("button", { name: "Tilføj station" }).click();

    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("cell").first()).toHaveText(stationNo);

    // The menu closes when the page scrolls, so the row is brought into view
    // before the click and not by it.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("button", { name: `Handlinger for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Rediger" }).click();
    const edit = page.getByRole("dialog", { name: `Rediger station ${stationNo}` });
    await expect(edit.getByRole("textbox", { name: "Stationsnr." })).toBeDisabled();
    const nameField = edit.getByRole("textbox", { name: "Navn", exact: true });
    await nameField.fill(`${name} rettet`);
    await edit.getByRole("button", { name: "Gem station" }).click();

    await expect(page.getByRole("row").filter({ hasText: `${name} rettet` })).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
