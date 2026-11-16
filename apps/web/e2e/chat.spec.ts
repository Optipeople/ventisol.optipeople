import { expect, test } from "./fixtures";

// playwright.config.ts starts the server with no AI Gateway key and no OIDC token.
test("chat says AI is not configured without a key", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeVisible();
  await expect(page.getByText(/AI er ikke konfigureret på denne server/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Dit spørgsmål" })).toBeDisabled();
});
