import { expect, test } from "./fixtures";

// playwright.config.ts starts the server with no Anthropic API key.
test("chat says AI is not configured without a key", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeAttached();
  await expect(page.getByText(/AI er ikke konfigureret på denne server/)).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("an empty chat shows the intro, the caveat and the starter questions", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByText("Spørg om ordrer, stationer, ventetid og nøgletal i produktionen.")).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Jeg kan tage fejl.");
  await expect(page.getByRole("button", { name: "Hvad skal ledelsen vide i dag?" })).toBeDisabled();
});

test("the chat fills the window and the page itself does not scroll", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("textbox")).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the conversation sidebar folds to a rail and opens again", async ({ page }) => {
  await page.goto("/chat");
  const sidebar = page.getByRole("complementary", { name: "Samtaler" });
  await expect(sidebar.getByRole("link", { name: "Ny samtale" })).toBeVisible();
  await sidebar.getByRole("button", { name: "Luk" }).first().click();
  await expect(sidebar.getByRole("link", { name: "Ny samtale" })).toBeHidden();
  await sidebar.getByRole("button", { name: "Åbn sidepanel" }).first().click();
  await expect(sidebar.getByRole("link", { name: "Ny samtale" })).toBeVisible();
});
