import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProviderId, PublicDataset, TrialResult } from "@repair-lab/core";
import { parseManifest } from "./manifest.js";
import { parseComparison, validateComparisonTrials } from "./public-comparison.js";
export { parseManifest, type ExperimentManifest } from "./manifest.js";
export { summarize } from "./summary.js";

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
  if (value.route !== undefined && (!["vercel-ai-gateway", "openrouter"].includes(String(value.route)) || value.provider !== "jev")) {
    throw new Error("Invalid trial route");
  }
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
    route: trial.route,
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

export interface FinalComparisonRun {
  manifest: unknown;
  completion: unknown;
  schedule: unknown;
  trials: TrialResult[];
}

export async function readFinalComparisonRun(directory: string): Promise<FinalComparisonRun> {
  const readJson = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(directory, name), "utf8"));
  const [manifest, completion, schedule, trials] = await Promise.all([
    readJson("manifest.json"), readJson("completion.json"), readJson("schedule.json"),
    readTrials(join(directory, "results.json")),
  ]);
  await Promise.all(trials.map(async (trial, index) => {
    const original = await readJson(`trial-${String(index).padStart(4, "0")}.json`);
    if (!isDeepStrictEqual(trial, original)) throw new Error("Aggregate results differ from original trial records");
  }));
  return { manifest, completion, schedule, trials };
}

export function publicComparisonDataset(runs: readonly FinalComparisonRun[], publicationApproved: boolean): PublicDataset {
  if (!publicationApproved) throw new Error("Confirm publication permission before exporting any results");
  if (runs.length < 2 || runs.length > 3) throw new Error("Comparison requires two or three distinct single-provider final runs");
  const manifests = runs.map((run) => parseManifest(run.manifest));
  const reference = manifests[0]!;
  const expectedCaseIds = [...reference.caseIds].sort();
  const providers = new Set<ProviderId>();
  const provenance = runs.map((run, index) => {
    const manifest = manifests[index]!;
    if (manifest.split !== "final" || manifest.providers.length !== 1) {
      throw new Error("Comparison requires frozen final runs with one provider each");
    }
    const provider = manifest.providers[0]!;
    if (providers.has(provider)) throw new Error("Duplicate comparison provider");
    providers.add(provider);
    if (JSON.stringify([...manifest.caseIds].sort()) !== JSON.stringify(expectedCaseIds) ||
        manifest.seed !== reference.seed || manifest.repetitions !== reference.repetitions ||
        manifest.lockfileSha256 !== reference.lockfileSha256 || manifest.instructionSha256 !== reference.instructionSha256) {
      throw new Error("Comparison manifests differ in case sets, seed, repetitions, or shared hashes");
    }
    const count = manifest.caseIds.length * manifest.repetitions;
    const completion = run.completion;
    if (!record(completion) || completion.status !== "completed" ||
        completion.expectedTrials !== count || completion.recordedTrials !== count ||
        !Array.isArray(completion.remainingTrials) || completion.remainingTrials.length !== 0 || completion.error !== null ||
        run.trials.length !== count) {
      throw new Error("Comparison requires complete final runs without errors or remaining trials");
    }
    if (!Array.isArray(run.schedule) || run.schedule.length !== count) throw new Error("Incomplete comparison schedule");
    const repetitions = new Set<string>();
    const times: number[] = [];
    for (const [ordinal, task] of run.schedule.entries()) {
      const trial = run.trials[ordinal]!;
      assertTrial(trial);
      if (!record(task) || typeof task.caseId !== "string" || !manifest.caseIds.includes(task.caseId) ||
          task.provider !== provider || typeof task.repetition !== "number" || !Number.isInteger(task.repetition) ||
          task.repetition < 0 || task.repetition >= manifest.repetitions) {
        throw new Error("Invalid comparison schedule repetition");
      }
      const key = `${task.caseId}:${task.repetition}`;
      if (repetitions.has(key)) throw new Error("Duplicate comparison schedule repetition");
      repetitions.add(key);
      if (trial.caseId !== task.caseId || trial.provider !== task.provider ||
          trial.sourceSha !== manifest.sourceSha || !/^[a-f0-9]{40}$/.test(trial.sourceSha) ||
          !Number.isFinite(Date.parse(trial.recordedAt))) {
        throw new Error("Comparison trial differs from its manifest or schedule");
      }
      times.push(Date.parse(trial.recordedAt));
    }
    const frozenSchedule = shuffled(manifest.caseIds, manifest.seed).flatMap((caseId) =>
      Array.from({ length: manifest.repetitions }, (_, repetition) => ({ caseId, provider, repetition })));
    if (!isDeepStrictEqual(run.schedule, frozenSchedule)) throw new Error("Comparison schedule differs from its frozen seed and case order");
    return {
      provider, sourceSha: manifest.sourceSha, frozenAt: manifest.frozenAt,
      firstRecordedAt: new Date(Math.min(...times)).toISOString(),
      lastRecordedAt: new Date(Math.max(...times)).toISOString(),
      seed: manifest.seed, repetitions: manifest.repetitions, trialCount: count,
    };
  });
  const comparison = parseComparison({
    kind: "separate-final-runs", split: "final", caseIds: expectedCaseIds,
    seed: reference.seed, repetitions: reference.repetitions,
    lockfileSha256: reference.lockfileSha256, instructionSha256: reference.instructionSha256,
    runs: provenance,
  });
  const trials = runs.flatMap((run) => run.trials);
  validateComparisonTrials(comparison, trials);
  const sources = new Set(manifests.map((manifest) => manifest.sourceSha));
  return {
    schemaVersion: 1,
    label: "Recorded final comparison; separate provider schedules",
    generatedAt: new Date().toISOString(),
    sourceSha: sources.size === 1 ? reference.sourceSha : null,
    publicationApproved: true,
    comparison,
    trials: runs.flatMap((run) => publicDataset(run.trials, true).trials),
  };
}
