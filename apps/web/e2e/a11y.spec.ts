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

for (const [name, path] of TABS) {
  test(`${name} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await page.waitForLoadState("networkidle");

    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
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
