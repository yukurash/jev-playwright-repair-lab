import { describe, expect, it } from "vitest";
import { cases, datasetManifest, fixtureCases, NEUTRAL_CONTROL_HELP } from "../../../fixtures/cases/index.js";
import { evaluateOracle, oracleFor } from "../../../fixtures/oracles/index.js";
import { renderPage } from "../../../apps/fixture/src/index.js";

describe("authored dataset boundaries", () => {
  it("contains 30 two-variant families without cross-split leakage", () => {
    expect(cases).toHaveLength(60);
    expect(new Set(cases.map((item) => item.id)).size).toBe(60);
    const families = new Map<string, typeof cases[number][]>();
    for (const fixture of cases) families.set(fixture.familyId, [...(families.get(fixture.familyId) ?? []), fixture]);
    expect(families.size).toBe(30);
    for (const family of families.values()) {
      expect(family).toHaveLength(2);
      expect(new Set(family.map((item) => item.split)).size).toBe(1);
    }
    expect(cases.filter((item) => item.split === "development")).toHaveLength(12);
    expect(cases.filter((item) => item.split === "calibration")).toHaveLength(12);
    expect(cases.filter((item) => item.split === "final")).toHaveLength(36);
    for (const category of ["rename", "container", "ambiguous", "missing", "regression", "guard"]) {
      expect(cases.filter((item) => item.category === category)).toHaveLength(10);
    }
  });

  it("exports only metadata, not semantic answers, in the public manifest", () => {
    for (const item of datasetManifest.cases) {
      expect(Object.keys(item).sort()).toEqual(["category", "familyId", "id", "split", "title"]);
    }
    expect(datasetManifest.independenceUnit).toBe("familyId");
  });

  it.each(["development", "calibration", "final"] as const)("helper text cannot distinguish targets from distractors anywhere in %s", (split) => {
    const helperRoles = new Map<string, Set<string>>();
    for (const fixture of fixtureCases.filter((item) => item.split === split)) {
      for (const phase of ["before", "after"] as const) {
        const controls = fixture[phase].controls;
        for (const control of controls) {
          expect(control.help, `${fixture.id}/${phase}/${control.key}`).toBe(NEUTRAL_CONTROL_HELP);
          const roles = helperRoles.get(control.help!) ?? new Set<string>();
          roles.add(control.key === "k1" ? "target" : "distractor");
          helperRoles.set(control.help!, roles);
        }
        const target = controls.find((control) => control.key === "k1");
        if (target) {
          const helperOnlyMatches = controls.filter((control) => control.help === target.help);
          expect(helperOnlyMatches, `${fixture.id}/${phase}`).toEqual(controls);
          expect(helperOnlyMatches.length, `${fixture.id}/${phase}`).toBeGreaterThan(1);
        }
      }
    }
    expect([...helperRoles.keys()]).toEqual([NEUTRAL_CONTROL_HELP]);
    expect(helperRoles.get(NEUTRAL_CONTROL_HELP)).toEqual(new Set(["target", "distractor"]));
  });

  it("stores separate business truth and catches target-correct corrupt state", () => {
    const fixture = fixtureCases.find((item) => item.id === "payment-double-charge-a")!;
    expect(evaluateOracle(fixture, { lastAction: "k1", state: { charges: 2, amount: 80 } })).toEqual({ targetCorrect: true, oraclePassed: false });
    expect(evaluateOracle(fixture, { lastAction: "k2", state: oracleFor(fixture).expected })).toEqual({ targetCorrect: false, oraclePassed: false });
  });

  it("never embeds executable JavaScript in replay markup", () => {
    for (const fixture of fixtureCases) {
      expect(renderPage(fixture.before)).not.toMatch(/<script|\son[a-z]+\s*=|javascript:|<iframe/i);
      expect(renderPage(fixture.after)).not.toMatch(/<script|\son[a-z]+\s*=|javascript:|<iframe/i);
    }
  });
});
