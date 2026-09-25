import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProviderId, TrialResult } from "@repair-lab/core";
import { publicComparisonDataset, publicDataset, readFinalComparisonRun, shuffled, type FinalComparisonRun } from "./index.js";
import type { ExperimentManifest } from "./manifest.js";
import { parseComparison, validateComparisonTrials } from "./public-comparison.js";

function run(provider: ProviderId, sourceSha = "a".repeat(40)) {
  const manifest: ExperimentManifest = {
    schemaVersion: 1, sourceSha, split: "final", caseIds: ["one-a", "one-b"],
    providers: [provider], repetitions: 3, seed: 42,
    frozenAt: "2026-09-24T00:00:00.000Z",
    lockfileSha256: "c".repeat(64), instructionSha256: "d".repeat(64),
    providerConfigSha256: provider === "rule" ? null : "e".repeat(64),
  };
  const schedule = shuffled(manifest.caseIds, manifest.seed).flatMap((caseId) =>
    Array.from({ length: manifest.repetitions }, (_, repetition) => ({ caseId, provider, repetition })));
  const trials: TrialResult[] = schedule.map(({ caseId }, index) => ({
    schemaVersion: 1, caseId, familyId: "one", split: "final",
    category: "rename", title: "Save settings", provider, model: provider === "azure" ? "gpt-5.5" : provider,
    status: "repaired", decision: "c0", expectedDecision: "c0",
    baselinePassed: true, originalTestPassed: true, oraclePassed: true, targetCorrect: true,
    repairable: true, beforeHtml: "<button>Save</button>", afterHtml: "<button>Update</button>",
    originalTest: "original", repairedTest: "patched",
    candidates: [{ id: "c0", locator: { kind: "role", role: "button", name: "Update" }, context: "Settings" }],
    latency: { captureMs: 2, decisionMs: 1, validationMs: 2, totalMs: 5 },
    sourceSha, recordedAt: `2026-09-24T00:01:0${index}.000Z`, inference: provider === "rule" ? "deterministic" : "live",
    ...(provider === "azure" ? { modelVersion: "2026-04-23", usage: { inputTokens: 100, outputTokens: 2 }, costUsd: 0.001 } : {}),
  }));
  return {
    manifest, schedule, trials,
    completion: { status: "completed", expectedTrials: 6, recordedTrials: 6, remainingTrials: [], error: null },
  };
}

describe("explicit final-run comparison export", () => {
  it("accepts mixed sources only explicitly, preserves old GPT values, and exposes only allowlisted provenance", () => {
    const gpt = run("azure");
    const jev = run("jev", "b".repeat(40));
    const rule = run("rule", "b".repeat(40));
    const before = JSON.stringify(gpt);
    const oldExport = JSON.parse(JSON.stringify(publicDataset(gpt.trials, true).trials));
    expect(() => publicDataset([...gpt.trials, ...jev.trials], true)).toThrow("different tested source");
    const dataset = publicComparisonDataset([gpt, jev, rule], true);
    expect(dataset.sourceSha).toBeNull();
    expect(dataset.trials).toHaveLength(18);
    expect(JSON.parse(JSON.stringify(dataset.trials.filter((trial) => trial.provider === "azure")))).toEqual(oldExport);
    expect(JSON.stringify(gpt)).toBe(before);
    expect(dataset.comparison?.runs.map((entry) => [entry.provider, entry.sourceSha, entry.trialCount])).toEqual([
      ["azure", "a".repeat(40), 6], ["jev", "b".repeat(40), 6], ["rule", "b".repeat(40), 6],
    ]);
    expect(JSON.stringify(dataset)).not.toMatch(/providerConfigSha256|generationId|requestId|metadata|privatePath/);
    expect(() => validateComparisonTrials(parseComparison(dataset.comparison), dataset.trials)).not.toThrow();
  });

  it("still exports empty and single-source data and retains a shared SHA when appropriate", () => {
    expect(publicDataset([], true).sourceSha).toBeNull();
    expect(publicDataset(run("azure").trials, true).comparison).toBeUndefined();
    expect(publicComparisonDataset([run("azure"), run("rule")], true).sourceSha).toBe("a".repeat(40));
  });

  it("requires approval, multiple runs, and distinct single-provider manifests", () => {
    expect(() => publicComparisonDataset([run("azure"), run("jev")], false)).toThrow("permission");
    expect(() => publicComparisonDataset([run("azure")], true)).toThrow("two or three");
    expect(() => publicComparisonDataset([run("azure"), run("azure")], true)).toThrow("Duplicate");
    const mixed = run("jev");
    mixed.manifest.providers.push("rule");
    expect(() => publicComparisonDataset([run("azure"), mixed], true)).toThrow("one provider");
  });

  it.each([
    ["split", "development"], ["sourceSha", `${"b".repeat(40)}-dirty`],
    ["seed", 43], ["repetitions", 2], ["caseIds", ["one-a", "other-b"]],
    ["instructionSha256", "f".repeat(64)], ["lockfileSha256", "f".repeat(64)],
  ])("rejects a mismatched or unfrozen manifest: %s", (field, value) => {
    const other = run("jev");
    expect(() => publicComparisonDataset([run("azure"), { ...other, manifest: { ...other.manifest, [field]: value } }], true)).toThrow();
  });

  it.each([
    ["status", "interrupted"], ["recordedTrials", 5], ["expectedTrials", 7],
    ["remainingTrials", [{}]], ["error", "interrupted"],
  ])("rejects incomplete completion records: %s", (field, value) => {
    const other = run("jev");
    expect(() => publicComparisonDataset([run("azure"), { ...other, completion: { ...other.completion, [field]: value } }], true)).toThrow("complete");
  });

  it("rejects missing completion, missing trials, mixed providers and duplicate/invalid repetition coverage", () => {
    const baseline = run("azure");
    const other = run("jev");
    const changes: Partial<FinalComparisonRun>[] = [
      { completion: undefined }, { trials: other.trials.slice(1) }, { schedule: other.schedule.slice(1) },
      { trials: [other.trials[0]!, ...other.trials.slice(0, 5)] },
      { schedule: other.schedule.map((task) => ({ ...task, repetition: 0 })) },
      { schedule: other.schedule.map((task) => ({ ...task, repetition: 3 })) },
      { schedule: other.schedule.map((task) => ({ ...task, repetition: 0.5 })) },
      { trials: other.trials.map((trial) => ({ ...trial, provider: "rule" })) },
      { trials: other.trials.map((trial) => ({ ...trial, sourceSha: "b".repeat(40) })) },
      { trials: other.trials.map((trial) => ({ ...trial, sourceSha: `${trial.sourceSha}-dirty` })) },
    ];
    for (const change of changes) expect(() => publicComparisonDataset([baseline, { ...other, ...change }], true)).toThrow();
  });

  it("rejects reordered trials even when they align with a reordered but unfrozen schedule", () => {
    const other = run("jev");
    expect(() => publicComparisonDataset([run("azure"), {
      ...other, schedule: [...other.schedule].reverse(), trials: [...other.trials].reverse(),
    }], true)).toThrow("frozen seed");
  });

  it.each([
    ["beforeHtml", "different snapshot"], ["afterHtml", "different snapshot"],
    ["originalTest", "different test"], ["expectedDecision", "NO_REPAIR"],
    ["repairable", false], ["familyId", "another"], ["category", "container"],
    ["title", "another case"], ["candidates", [{ id: "c0", locator: { kind: "label", label: "Update" }, context: "other" }]],
  ])("rejects mismatched actual case input %s within or across runs", (field, value) => {
    const other = run("jev");
    const altered = other.trials.map((trial, index) => index === 1 ? { ...trial, [field]: value } : trial);
    expect(() => publicComparisonDataset([run("azure"), { ...other, trials: altered }], true)).toThrow("case inputs differ");
  });

  it.each<Partial<TrialResult>>([
    { split: "development" }, { status: "error" }, { error: "failure" }, { baselinePassed: false },
    { recordedAt: "invalid" }, { recordedAt: "2026-09-23T00:00:00.000Z" },
  ])("rejects trial errors, wrong splits and invalid chronology: %j", (change) => {
    const other = run("jev");
    expect(() => publicComparisonDataset([run("azure"), { ...other, trials: other.trials.map((trial) => ({ ...trial, ...change })) }], true)).toThrow();
  });

  it("reads original trial files and rejects modified aggregate results or missing run artifacts", async () => {
    const directory = fileURLToPath(new URL(`../.comparison-test-${crypto.randomUUID()}/`, import.meta.url));
    const original = run("azure");
    await mkdir(directory, { recursive: true });
    try {
      for (const [name, value] of Object.entries({
        manifest: original.manifest, completion: original.completion, schedule: original.schedule, results: original.trials,
        ...Object.fromEntries(original.trials.map((trial, index) => [`trial-${String(index).padStart(4, "0")}`, trial])),
      })) await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
      expect(await readFinalComparisonRun(directory)).toEqual(original);
      await writeFile(join(directory, "results.json"), JSON.stringify(original.trials.map((trial) => ({ ...trial, costUsd: 1 }))));
      await expect(readFinalComparisonRun(directory)).rejects.toThrow("original trial records");
      await rm(join(directory, "completion.json"));
      await expect(readFinalComparisonRun(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
