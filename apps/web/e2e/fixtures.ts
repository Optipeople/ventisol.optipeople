import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

// `page.goto` that also waits for the network to go quiet. Under `next dev`
// the client code arrives after the HTML, and a click or a keystroke before
// React has hydrated does nothing (a toggle, a select, the search box).
export const test = base.extend({
  // `provide` rather than `use`: the React hooks lint rule reads any `use` call as a hook.
  page: async ({ page }, provide) => {
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await page.waitForLoadState("networkidle");
      return response;
    };
    await provide(page);
  },
});
