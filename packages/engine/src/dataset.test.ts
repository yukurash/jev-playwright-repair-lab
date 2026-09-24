import { describe, expect, it } from "vitest";
import { cases, datasetManifest, fixtureCases } from "../../../fixtures/cases/index.js";
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
