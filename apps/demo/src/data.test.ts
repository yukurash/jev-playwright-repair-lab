import { describe, expect, it } from "vitest";
import { describeTrials, formatCost, parseDataset } from "./data";
import { datasetFixture, trialFixture } from "./test-fixtures";

describe("public dataset validation", () => {
  it("accepts the deliberate uncollected state and valid recorded trials", () => {
    expect(parseDataset(datasetFixture()).trials).toEqual([]);
    expect(parseDataset(datasetFixture([trialFixture()])).trials).toHaveLength(1);
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
