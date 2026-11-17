import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

// Accessibility smoke test of the four report tabs. Fails on serious and
// critical violations only; minor and moderate ones are printed, not failed.
const TABS = [
  ["Overblik", "/"],
  ["Stationer", "/stationer"],
  ["Ordrer", "/ordrer"],
  ["Ledelse", "/ledelse"],
] as const;

// Two known findings come from @optipeople/ui 0.2.2, not from this app, and
// can only be fixed there. They are left out here so the check still catches
// what this app adds. Remove both lines when the package is fixed.
// 1. The label grey (--ds-grey-medium-04) has a contrast of 3.85 on white.
const UI_LABEL_GREY = "#758585";
// 2. The user menu button's aria-label is the email, its visible text the name.
const UI_USER_MENU = 'button[aria-haspopup="menu"][aria-label*="@"]';

for (const [name, path] of TABS) {
  test(`${name} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await page.waitForLoadState("networkidle");

    const { violations: found } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .exclude(UI_USER_MENU)
      .analyze();
    const violations = found
      .map((v) =>
        v.id === "color-contrast"
          ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(UI_LABEL_GREY))) }
          : v
      )
      .filter((v) => v.nodes.length > 0);
    const summary = violations.map((v) =>
      [
        `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}x)`,
        ...v.nodes.slice(0, 3).map((n) => `    ${n.target.join(" ")}: ${n.any[0]?.message ?? n.failureSummary ?? ""}`),
      ].join("\n")
    );
    if (summary.length) console.log(`axe ${path}\n  ${summary.join("\n  ")}`);

    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
  });
}
