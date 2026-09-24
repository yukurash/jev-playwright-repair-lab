import { describe, expect, it } from "vitest";
import { fixtureCases } from "../../../fixtures/cases/index.js";
import { analyzeTest, patchLocator, UnsupportedTestError } from "./patch.js";
import { isActionFailure } from "./browser.js";

const original = `test("save", async ({ page }) => {
  await page.goto(baseURL);
  await page.getByRole("group", { name: "Editor", exact: true }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("status")).toHaveText("Saved");
});`;

describe("verified AST locator-only patch", () => {
  it("changes exactly the locator range, preserving action and assertions byte for byte", () => {
    const site = analyzeTest(original);
    const patched = patchLocator(original, site, { kind: "role", role: "button", name: "Apply", scope: "Document" });
    const newSite = analyzeTest(patched);
    expect(patched.slice(0, newSite.start)).toBe(original.slice(0, site.start));
    expect(patched.slice(newSite.end)).toBe(original.slice(site.end));
    expect(patched).toContain('.click();');
    expect(patched).toContain('toHaveText("Saved")');
  });

  it("preserves a fill value including escapes and never edits a same-named assertion", () => {
    const source = `test("input", async ({ page }) => {
  await page.getByLabel("Name", { exact: true }).fill("Ada \\"Example\\"");
  await expect(page.getByTestId("status")).toHaveText("Name");
});`;
    const site = analyzeTest(source);
    const patched = patchLocator(source, site, { kind: "role", role: "textbox", name: "Display name" });
    expect(patched.slice(analyzeTest(patched).end)).toBe(source.slice(site.end));
  });

  it("does not confuse locator-like comments or assertion locators with the action", () => {
    const source = `// page.getByRole("button", { name: "Save", exact: true }).click()\n${original}`;
    const site = analyzeTest(source);
    expect(site.startLine).toBe(4);
    expect(source.slice(site.start, site.end)).toContain('"Editor"');
  });

  it("uses source columns so an assertion on the same line cannot masquerade as an action failure", () => {
    const source = 'test("inline", async ({ page }) => { await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByTestId("status")).toHaveText("Saved"); });';
    const site = analyzeTest(source);
    expect(isActionFailure({ passed: false, failureLine: 1, failureColumn: source.indexOf("toHaveText") + 1 }, site)).toBe(false);
    expect(isActionFailure({ passed: false, failureLine: 1, failureColumn: source.indexOf("click") + 1 }, site)).toBe(true);
    expect(isActionFailure({ passed: false, failureLine: null, failureColumn: null }, site)).toBe(false);
  });

  it("rejects a stale or forged AST range", () => {
    const site = analyzeTest(original);
    expect(() => patchLocator(original, { ...site, start: site.start + 1 }, { kind: "role", role: "button", name: "Apply" })).toThrow("AST locator range");
  });

  it("rejects a replacement with the wrong role", () => {
    expect(() => patchLocator(original, analyzeTest(original), { kind: "role", role: "textbox", name: "Name" })).toThrow("incompatible");
  });

  it.each([
    'page.getByRole("button", { name: dynamicName, exact: true }).click()',
    'selectControl().click()',
    'page.getByRole("button", { name: "Save", exact: true }).first().click()',
    'page.getByRole("button", { name: "Save", exact: true }).click({ force: true })',
    'page.getByRole("button", { name: "Save" }).click()',
    'page.locator("#save").click()',
    'page.getByRole("button", { name: /Save/, exact: true }).click()',
    'page.getByLabel("Name", { exact: true }).fill(value)',
    'page.getByRole("button", { name: "Save", exact: true, hidden: true }).click()',
    'page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Save", exact: true }).click()',
  ])("rejects unsupported expression %s", (action) => {
    expect(() => analyzeTest(`test("unsupported", async ({ page }) => { await ${action}; });`)).toThrow(UnsupportedTestError);
  });

  it("rejects multiple actions rather than guessing the action to patch", () => {
    expect(() => analyzeTest(original.replace("  await expect", '  await page.getByRole("button", { name: "Next", exact: true }).click();\n  await expect'))).toThrow("Exactly one");
  });

  it("supports all non-helper/static fixture sources and explicitly rejects the guard sources", () => {
    for (const fixture of fixtureCases) {
      if (["dynamic-locator", "helper-locator", "unsafe-locator-options"].includes(fixture.familyId)) {
        expect(() => analyzeTest(fixture.originalTest), fixture.id).toThrow(UnsupportedTestError);
      } else {
        expect(analyzeTest(fixture.originalTest).operation, fixture.id).toBe(fixture.before.controls.find((control) => control.key === "k1")?.kind === "textbox" ? "fill" : "click");
      }
    }
  });
});
