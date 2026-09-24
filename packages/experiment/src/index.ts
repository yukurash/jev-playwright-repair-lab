import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProviderId, PublicDataset, TrialResult } from "@repair-lab/core";
export { parseManifest, type ExperimentManifest } from "./manifest.js";

function canonicalDestination(path: string): string {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Output has no existing filesystem ancestor");
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}

export function assertPrivatePath(path: string, repository: string): string {
  const absolute = canonicalDestination(path);
  const rel = relative(canonicalDestination(repository), absolute);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error("Private output must be outside the public repository");
  }
  return absolute;
}

export function summarize(trials: readonly TrialResult[]) {
  const providers: ProviderId[] = ["rule", "azure", "jev"];
  return providers.map((provider) => {
    const rows = trials.filter((trial) => trial.provider === provider);
    const repairable = rows.filter((trial) => trial.repairable);
    const decisions = rows.filter((trial) => trial.decision !== null);
    const successes = repairable.filter((trial) =>
      trial.status === "repaired" && trial.targetCorrect === true &&
      trial.originalTestPassed === true && trial.oraclePassed === true);
    const latencies = decisions.map((trial) => trial.latency.decisionMs).sort((a, b) => a - b);
    const costs = rows.flatMap((trial) => trial.costUsd === undefined ? [] : [trial.costUsd]);
    return {
      provider,
      trials: rows.length,
      families: new Set(rows.map((trial) => trial.familyId)).size,
      repairableTrials: repairable.length,
      correctRepairs: successes.length,
      correctRepairRate: repairable.length ? successes.length / repairable.length : null,
      decisions: decisions.length,
      wrongTargetGreen: rows.filter((trial) => trial.originalTestPassed === true && trial.targetCorrect === false).length,
      rightTargetRegressionGreen: rows.filter((trial) =>
        trial.originalTestPassed === true && trial.targetCorrect === true && trial.oraclePassed === false).length,
      correctNoRepair: rows.filter((trial) => trial.expectedDecision === "NO_REPAIR" && trial.decision === "NO_REPAIR").length,
      abstentions: rows.filter((trial) => trial.decision === "ABSTAIN").length,
      guards: rows.filter((trial) => trial.status === "unsupported" || trial.status === "unchanged").length,
      errors: rows.filter((trial) => trial.status === "error").length,
      decisionLatencyObservations: latencies.length,
      decisionLatencyP50Ms: quantile(latencies, 0.5),
      decisionLatencyP95Ms: quantile(latencies, 0.95),
      costObservations: costs.length,
      observedCostUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      missingCostTrials: rows.length - costs.length,
    };
  });
}

function quantile(sorted: number[], fraction: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const output = [...values];
  for (let i = output.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 0x1_0000_0000) * (i + 1));
    [output[i], output[j]] = [output[j]!, output[i]!];
  }
  return output;
}

export async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function readTrials(path: string): Promise<TrialResult[]> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(data)) throw new Error("Run results must be a JSON array");
  for (const item of data) assertTrial(item);
  return data;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function assertTrial(value: unknown): asserts value is TrialResult {
  if (!record(value) || value.schemaVersion !== 1) throw new Error("Invalid trial schema");
  for (const key of ["caseId", "familyId", "title", "model", "beforeHtml", "afterHtml", "originalTest", "sourceSha", "recordedAt"]) {
    if (typeof value[key] !== "string") throw new Error(`Invalid trial field: ${key}`);
  }
  for (const key of ["decision", "expectedDecision"]) {
    if (value[key] !== null && typeof value[key] !== "string") throw new Error(`Invalid trial field: ${key}`);
  }
  const enums = {
    provider: ["rule", "azure", "jev"],
    split: ["development", "calibration", "final"],
    category: ["rename", "container", "ambiguous", "missing", "regression", "guard"],
    status: ["repaired", "rejected", "abstained", "unsupported", "unchanged", "error"],
    inference: ["live", "deterministic"],
  };
  for (const [key, options] of Object.entries(enums)) {
    if (typeof value[key] !== "string" || !options.includes(value[key])) throw new Error(`Invalid trial field: ${key}`);
  }
  for (const key of ["baselinePassed", "repairable"]) {
    if (typeof value[key] !== "boolean") throw new Error(`Invalid trial field: ${key}`);
  }
  for (const key of ["originalTestPassed", "oraclePassed", "targetCorrect"]) {
    if (value[key] !== null && typeof value[key] !== "boolean") throw new Error(`Invalid trial field: ${key}`);
  }
  const latency = value.latency;
  if (!record(latency) ||
      !["captureMs", "decisionMs", "validationMs", "totalMs"].every((key) => nonnegative(latency[key]))) {
    throw new Error("Invalid trial latency");
  }
  if (value.costUsd !== undefined && !nonnegative(value.costUsd)) throw new Error("Invalid trial cost");
  if (value.usage !== undefined) {
    if (!record(value.usage) || !nonnegative(value.usage.inputTokens) || !nonnegative(value.usage.outputTokens)) throw new Error("Invalid trial usage");
    for (const key of ["reasoningTokens", "cachedInputTokens"]) {
      if (value.usage[key] !== undefined && !nonnegative(value.usage[key])) throw new Error("Invalid trial usage");
    }
  }
  if (value.confidence !== undefined && (!nonnegative(value.confidence) || value.confidence > 1)) throw new Error("Invalid confidence");
  if (value.probabilities !== undefined &&
      (!record(value.probabilities) || !Object.values(value.probabilities).every((p) => nonnegative(p) && p <= 1))) {
    throw new Error("Invalid probabilities");
  }
  for (const key of ["modelVersion", "repairedTest", "error", "reason"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`Invalid trial field: ${key}`);
  }
  if (!Array.isArray(value.candidates)) throw new Error("Invalid candidates");
  for (const candidate of value.candidates) {
    if (!record(candidate) || typeof candidate.id !== "string" || !/^c\d+$/.test(candidate.id) ||
        typeof candidate.context !== "string" || !record(candidate.locator)) throw new Error("Invalid candidate");
    const locator = candidate.locator;
    if (locator.scope !== undefined && typeof locator.scope !== "string") throw new Error("Invalid candidate scope");
    if (locator.kind === "role") {
      if (!["button", "textbox"].includes(String(locator.role)) || typeof locator.name !== "string") throw new Error("Invalid role locator");
    } else if (locator.kind !== "label" || typeof locator.label !== "string") {
      throw new Error("Invalid label locator");
    }
  }
}

export function publicDataset(trials: TrialResult[], publicationApproved: boolean): PublicDataset {
  if (!publicationApproved) throw new Error("Confirm publication permission before exporting any results");
  for (const trial of trials) assertTrial(trial);
  const sourceShas = new Set(trials.map((trial) => trial.sourceSha));
  if (sourceShas.size > 1) throw new Error("Do not combine different tested source commits");
  const projected = trials.map((trial): TrialResult => ({
    schemaVersion: 1,
    caseId: trial.caseId,
    familyId: trial.familyId,
    split: trial.split,
    category: trial.category,
    title: trial.title,
    provider: trial.provider,
    model: trial.model,
    modelVersion: trial.modelVersion,
    status: trial.status,
    decision: trial.decision,
    expectedDecision: trial.expectedDecision,
    baselinePassed: trial.baselinePassed,
    originalTestPassed: trial.originalTestPassed,
    oraclePassed: trial.oraclePassed,
    targetCorrect: trial.targetCorrect,
    repairable: trial.repairable,
    beforeHtml: trial.beforeHtml,
    afterHtml: trial.afterHtml,
    originalTest: trial.originalTest,
    repairedTest: trial.repairedTest,
    candidates: trial.candidates.map((candidate) => ({
      id: candidate.id,
      context: candidate.context,
      locator: candidate.locator.kind === "role"
        ? { kind: "role", role: candidate.locator.role, name: candidate.locator.name, scope: candidate.locator.scope }
        : { kind: "label", label: candidate.locator.label, scope: candidate.locator.scope },
    })),
    latency: {
      captureMs: trial.latency.captureMs,
      decisionMs: trial.latency.decisionMs,
      validationMs: trial.latency.validationMs,
      totalMs: trial.latency.totalMs,
    },
    usage: trial.usage === undefined ? undefined : {
      inputTokens: trial.usage.inputTokens,
      outputTokens: trial.usage.outputTokens,
      reasoningTokens: trial.usage.reasoningTokens,
      cachedInputTokens: trial.usage.cachedInputTokens,
    },
    costUsd: trial.costUsd,
    confidence: trial.confidence,
    probabilities: trial.probabilities,
    error: trial.error === undefined ? undefined : "Execution error; inspect the private run log.",
    reason: trial.status === "error" ? undefined : trial.reason,
    sourceSha: trial.sourceSha,
    recordedAt: trial.recordedAt,
    inference: trial.inference,
  }));
  return {
    schemaVersion: 1,
    label: trials.some((trial) => trial.inference === "live") ? "Recorded API experiment" : "Deterministic baseline only; API comparison not collected",
    generatedAt: new Date().toISOString(),
    sourceSha: trials[0]?.sourceSha ?? null,
    publicationApproved: true,
    trials: projected,
  };
}
