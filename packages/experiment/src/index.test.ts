import { describe, expect, it } from "vitest";
import { assertPrivatePath, assertTrial, publicDataset, shuffled, summarize } from "./index.js";
import type { TrialResult } from "@repair-lab/core";

const trial: TrialResult = {
  schemaVersion: 1, caseId: "one-a", familyId: "one", split: "development",
  category: "rename", title: "Save settings", provider: "rule", model: "rule-v1",
  status: "repaired", decision: "c0", expectedDecision: "c0",
  baselinePassed: true, originalTestPassed: true, oraclePassed: true, targetCorrect: true,
  repairable: true, beforeHtml: "<button>Save</button>", afterHtml: "<button>Update</button>",
  originalTest: "original", repairedTest: "patched",
  candidates: [{ id: "c0", locator: { kind: "role", role: "button", name: "Update" }, context: "Settings" }],
  latency: { captureMs: 2, decisionMs: 1, validationMs: 2, totalMs: 5 },
  sourceSha: "a".repeat(40), recordedAt: "2026-09-24T00:00:00.000Z", inference: "deterministic",
};

describe("experiment integrity", () => {
  it("rejects outputs inside the public repository", () => {
    expect(() => assertPrivatePath("public/private/run.json", "public")).toThrow();
    expect(() => assertPrivatePath("public", "public")).toThrow();
    expect(() => assertPrivatePath("public/..hidden/file", "public")).toThrow();
    expect(assertPrivatePath("private/run.json", "public")).toContain("private");
  });
  it("leaves missing measurements missing", () => {
    const rows = summarize([]);
    expect(rows[0]).toMatchObject({ trials: 0, correctRepairRate: null, decisionLatencyP50Ms: null, observedCostUsd: null });
  });
  it("requires explicit publication approval", () => {
    expect(() => publicDataset([], false)).toThrow();
    expect(publicDataset([], true).trials).toEqual([]);
  });
  it("uses a reproducible permutation without editing the original list", () => {
    const values = [1, 2, 3, 4, 5];
    expect(shuffled(values, 42)).toEqual(shuffled(values, 42));
    expect(shuffled(values, 42).sort()).toEqual(values);
  });
  it("rejects success-shaped malformed input", () => {
    expect(() => assertTrial({ schemaVersion: 1, status: "repaired" })).toThrow();
  });
  it("separates wrong-target green from a bug missed by the original assertion", () => {
    const summary = summarize([
      trial,
      { ...trial, targetCorrect: false, status: "rejected" },
      { ...trial, oraclePassed: false, repairable: false, status: "rejected" },
      { ...trial, decision: null, status: "unchanged", repairable: false },
    ])[0]!;
    expect(summary).toMatchObject({
      correctRepairs: 1, repairableTrials: 2, correctRepairRate: 0.5,
      wrongTargetGreen: 1, rightTargetRegressionGreen: 1,
      decisions: 3, guards: 1, missingCostTrials: 4, families: 1,
    });
  });
  it("whitelists publication fields and redacts private error detail", () => {
    const result = publicDataset([{ ...trial, status: "error", error: "private-transport-details" }], true);
    expect(JSON.stringify(result)).not.toContain("private-transport-details");
    expect(() => publicDataset([trial, { ...trial, sourceSha: "b".repeat(40) }], true)).toThrow();
  });
  it.each(["vercel-ai-gateway", "openrouter"] as const)("preserves %s without inventing an upstream model version", (route) => {
    const recorded: TrialResult = { ...trial, provider: "jev", model: "test-jev", route };
    const exported = publicDataset([recorded], true).trials[0]!;
    expect(exported.route).toBe(route);
    expect(exported.modelVersion).toBeUndefined();
    expect(() => assertTrial({ ...recorded, route: "unverified-route" })).toThrow();
    expect(() => assertTrial({ ...recorded, provider: "azure" })).toThrow();
  });
});
