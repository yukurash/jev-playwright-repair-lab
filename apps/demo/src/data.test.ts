import { describe, expect, it } from "vitest";
import { describeTrials, formatCost, parseDataset } from "./data";
import { comparisonFixture, datasetFixture, trialFixture } from "./test-fixtures";

describe("public dataset validation", () => {
  it("accepts the deliberate uncollected state and valid recorded trials", () => {
    expect(parseDataset(datasetFixture()).trials).toEqual([]);
    expect(parseDataset(datasetFixture([trialFixture()])).trials).toHaveLength(1);
    expect(parseDataset(datasetFixture([trialFixture({ provider: "jev", route: "vercel-ai-gateway" })])).trials[0]?.route).toBe("vercel-ai-gateway");
    expect(parseDataset(datasetFixture([trialFixture({ provider: "jev", route: "openrouter" })])).trials[0]?.route).toBe("openrouter");
  });

  it.each([
    ["schemaVersion", { schemaVersion: 2 }],
    ["trials", { trials: {} }],
    ["sourceSha", { sourceSha: "not-a-sha" }],
    ["generatedAt", { generatedAt: "not-a-date" }],
  ])("reports invalid dataset field %s", (field, change) => {
    expect(() => parseDataset({ ...datasetFixture(), ...change })).toThrow(field);
  });

  it("refuses nonempty unpublished data instead of displaying it", () => {
    expect(() => parseDataset({ ...datasetFixture([trialFixture()]), publicationApproved: false })).toThrow("publicationApproved");
  });

  it.each([
    ["oraclePassed", { oraclePassed: undefined }],
    ["status", { status: "success" }],
    ["decision", { decision: "c9" }],
    ["costUsd", { costUsd: -1 }],
    ["confidence", { confidence: 1.1 }],
    ["route", { route: "unverified-route" }],
    ["route", { provider: "azure", route: "vercel-ai-gateway" }],
    ["route", { provider: "azure", route: "openrouter" }],
    ["latency.totalMs", { latency: { captureMs: 0, decisionMs: 0, validationMs: 0, totalMs: Number.NaN } }],
    ["usage.inputTokens", { usage: { inputTokens: 1.2, outputTokens: 1 } }],
    ["candidates[0].locator.role", { candidates: [{ id: "c0", context: "", locator: { kind: "role", role: "admin", name: "" } }] }],
    ["probabilities.c8", { probabilities: { c8: 0.2 } }],
  ])("rejects malformed trial field %s", (field, change) => {
    expect(() => parseDataset({ ...datasetFixture(), publicationApproved: true, trials: [{ ...trialFixture(), ...change }] })).toThrow(field);
  });

  it("rejects duplicate candidate IDs and invalid recorded dates", () => {
    const trial = trialFixture();
    expect(() => parseDataset(datasetFixture([{ ...trial, candidates: [...trial.candidates, ...trial.candidates] }]))).toThrow("重複");
    expect(() => parseDataset(datasetFixture([{ ...trial, recordedAt: "never" }]))).toThrow("recordedAt");
  });

  it("accepts validated separate final-run provenance, but never invents a shared source SHA", () => {
    const comparison = comparisonFixture();
    expect(parseDataset(comparison)).toEqual(comparison);
    expect(() => parseDataset({ ...comparison, comparison: undefined })).toThrow("sourceSha");
    expect(() => parseDataset({ ...comparison, sourceSha: "a".repeat(40) })).toThrow("sourceSha");
    expect(() => parseDataset({ ...datasetFixture([trialFixture()]), sourceSha: "b".repeat(40) })).toThrow("sourceSha");
  });

  it.each([
    { kind: "randomized" }, { split: "development" }, { seed: 43 }, { repetitions: 2 },
    { instructionSha256: "invalid" }, { lockfileSha256: "invalid" },
    { caseIds: ["test-rename", "test-rename"] }, { caseIds: ["test-other"] },
    { providerConfigSha256: "e".repeat(64) }, { runs: [] },
  ])("rejects invalid comparison provenance %j", (change) => {
    const dataset = comparisonFixture();
    expect(() => parseDataset({ ...dataset, comparison: { ...dataset.comparison, ...change } })).toThrow(/comparison|Comparison/);
  });

  it.each([
    { sourceSha: "dirty" }, { sourceSha: "c".repeat(40) }, { seed: 0 },
    { trialCount: 2 }, { repetitions: 2 }, { frozenAt: "invalid" },
    { firstRecordedAt: "2026-01-01T00:01:01.000Z" },
    { lastRecordedAt: "2026-01-01T00:01:01.000Z" },
    { frozenAt: "2026-01-04T00:00:00.000Z" },
    { generationId: "not-public" },
  ])("rejects a tampered comparison run %j", (change) => {
    const dataset = comparisonFixture();
    const comparison = dataset.comparison!;
    const runs = comparison.runs.map((run, index) => index === 0 ? { ...run, ...change } : run);
    expect(() => parseDataset({ ...dataset, comparison: { ...comparison, runs } })).toThrow(/comparison|Comparison/);
  });

  it("rejects missing, mixed, input-mismatched or duplicate-provider comparison data", () => {
    const dataset = comparisonFixture();
    const comparison = dataset.comparison!;
    expect(() => parseDataset({ ...dataset, trials: dataset.trials.slice(1) })).toThrow("count");
    expect(() => parseDataset({
      ...dataset, comparison: { ...comparison, runs: [comparison.runs[0], comparison.runs[0], comparison.runs[2]] },
    })).toThrow("Duplicate");
    for (const change of [{ sourceSha: "c".repeat(40) }, { split: "development" }, { status: "error" }, { originalTest: "tampered" }]) {
      expect(() => parseDataset({
        ...dataset, trials: dataset.trials.map((trial, index) => index === 0 ? { ...trial, ...change } : trial),
      })).toThrow();
    }
    const wrongCase = dataset.trials.map((trial, index) => index === 0 ? { ...trial, caseId: "other" } : trial);
    expect(() => parseDataset({ ...dataset, trials: wrongCase })).toThrow("repetition coverage");
  });
});

describe("descriptive trial counts", () => {
  it("does not convert missing cost, missing validation, or empty samples into success", () => {
    expect(describeTrials([])).toEqual({ total: 0, repaired: 0, evaluated: 0, verified: 0, measuredCosts: 0, costUsd: null });
    expect(describeTrials([trialFixture({ oraclePassed: null, targetCorrect: null })])).toEqual({
      total: 1, repaired: 1, evaluated: 0, verified: 0, measuredCosts: 0, costUsd: null,
    });
  });

  it("keeps denominators explicit and does not equate repaired or assertion pass with correctness", () => {
    const trials = [
      trialFixture({ costUsd: 0.002 }),
      trialFixture({ oraclePassed: true, targetCorrect: true, costUsd: 0 }),
      trialFixture({ status: "abstained", oraclePassed: null, targetCorrect: null }),
      trialFixture({ oraclePassed: true, targetCorrect: null }),
    ];
    expect(describeTrials(trials)).toEqual({
      total: 4, repaired: 3, evaluated: 2, verified: 1, measuredCosts: 2, costUsd: 0.002,
    });
  });

  it("distinguishes an explicitly recorded zero from missing and tiny costs", () => {
    expect(formatCost(undefined)).toBe("未記録");
    expect(formatCost(null)).toBe("未記録");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.00000001)).not.toBe("$0.00");
  });
});
