import type { PublicComparison, PublicComparisonRun, TrialResult } from "@repair-lab/core";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sha(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function caseInputs(trial: TrialResult): string {
  return JSON.stringify({
    caseId: trial.caseId, familyId: trial.familyId, split: trial.split,
    category: trial.category, title: trial.title, repairable: trial.repairable,
    expectedDecision: trial.expectedDecision, beforeHtml: trial.beforeHtml,
    afterHtml: trial.afterHtml, originalTest: trial.originalTest,
    candidates: trial.candidates.map((candidate) => ({
      id: candidate.id, context: candidate.context,
      locator: candidate.locator.kind === "role"
        ? { kind: "role", role: candidate.locator.role, name: candidate.locator.name, scope: candidate.locator.scope }
        : { kind: "label", label: candidate.locator.label, scope: candidate.locator.scope },
    })),
  });
}

export function parseComparison(value: unknown): PublicComparison {
  if (!record(value) ||
      !exactKeys(value, ["kind", "split", "caseIds", "seed", "repetitions", "lockfileSha256", "instructionSha256", "runs"]) ||
      value.kind !== "separate-final-runs" || value.split !== "final" ||
      !Array.isArray(value.caseIds) || !value.caseIds.length ||
      !value.caseIds.every((id: unknown): id is string => typeof id === "string" && /^[a-z0-9-]+$/.test(id)) ||
      new Set(value.caseIds).size !== value.caseIds.length ||
      !integer(value.seed, 0, 0xffff_ffff) || !integer(value.repetitions, 1, 3) ||
      !sha(value.lockfileSha256, 64) || !sha(value.instructionSha256, 64) ||
      !Array.isArray(value.runs) || value.runs.length < 2 || value.runs.length > 3) {
    throw new Error("Invalid comparison provenance");
  }
  const trialCount = value.caseIds.length * value.repetitions;
  const runs: PublicComparisonRun[] = value.runs.map((run: unknown) => {
    if (!record(run) ||
        !exactKeys(run, ["provider", "sourceSha", "frozenAt", "firstRecordedAt", "lastRecordedAt", "seed", "repetitions", "trialCount"]) ||
        (run.provider !== "rule" && run.provider !== "azure" && run.provider !== "jev") ||
        !sha(run.sourceSha, 40) || !timestamp(run.frozenAt) ||
        !timestamp(run.firstRecordedAt) || !timestamp(run.lastRecordedAt) ||
        Date.parse(run.frozenAt) > Date.parse(run.firstRecordedAt) ||
        Date.parse(run.firstRecordedAt) > Date.parse(run.lastRecordedAt) ||
        !integer(run.seed, 0, 0xffff_ffff) || run.seed !== value.seed ||
        !integer(run.repetitions, 1, 3) || run.repetitions !== value.repetitions ||
        !integer(run.trialCount, 1) || run.trialCount !== trialCount) {
      throw new Error("Invalid comparison run provenance");
    }
    return {
      provider: run.provider, sourceSha: run.sourceSha, frozenAt: run.frozenAt,
      firstRecordedAt: run.firstRecordedAt, lastRecordedAt: run.lastRecordedAt,
      seed: run.seed, repetitions: run.repetitions, trialCount: run.trialCount,
    };
  });
  if (new Set(runs.map((run) => run.provider)).size !== runs.length) {
    throw new Error("Duplicate comparison provider");
  }
  return {
    kind: value.kind, split: value.split, caseIds: [...value.caseIds],
    seed: value.seed, repetitions: value.repetitions,
    lockfileSha256: value.lockfileSha256, instructionSha256: value.instructionSha256, runs,
  };
}

export function validateComparisonTrials(comparison: PublicComparison, trials: readonly TrialResult[]): void {
  if (trials.length !== comparison.runs.reduce((sum, run) => sum + run.trialCount, 0)) {
    throw new Error("Comparison trial count differs from provenance");
  }
  const inputs = new Map<string, string>();
  for (const run of comparison.runs) {
    const rows = trials.filter((trial) => trial.provider === run.provider);
    if (rows.length !== run.trialCount) throw new Error("Comparison provider coverage differs from provenance");
    for (const caseId of comparison.caseIds) {
      if (rows.filter((trial) => trial.caseId === caseId).length !== comparison.repetitions) {
        throw new Error("Incomplete comparison case repetition coverage");
      }
    }
    const dates: number[] = [];
    for (const trial of rows) {
      if (trial.sourceSha !== run.sourceSha || trial.split !== "final" ||
          trial.status === "error" || trial.error !== undefined || !trial.baselinePassed ||
          !comparison.caseIds.includes(trial.caseId) || !timestamp(trial.recordedAt) ||
          Date.parse(trial.recordedAt) < Date.parse(run.frozenAt)) {
        throw new Error("Comparison trial disagrees with its frozen final run");
      }
      const input = caseInputs(trial);
      const previous = inputs.get(trial.caseId);
      if (previous !== undefined && previous !== input) throw new Error(`Comparison case inputs differ: ${trial.caseId}`);
      inputs.set(trial.caseId, input);
      dates.push(Date.parse(trial.recordedAt));
    }
    if (Math.min(...dates) !== Date.parse(run.firstRecordedAt) || Math.max(...dates) !== Date.parse(run.lastRecordedAt)) {
      throw new Error("Comparison recorded time window differs from trials");
    }
  }
}
