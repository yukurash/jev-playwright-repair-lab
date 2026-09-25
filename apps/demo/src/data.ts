import type { Candidate, PublicDataset, TrialResult, Usage } from "../../../packages/core/src/index";
import { parseComparison, validateComparisonTrials } from "../../../packages/experiment/src/public-comparison";

const statuses = ["repaired", "rejected", "abstained", "unsupported", "unchanged", "error"];
const categories = ["rename", "container", "ambiguous", "missing", "regression", "guard"];
const providers = ["rule", "azure", "jev"];
const splits = ["development", "calibration", "final"];
const choice = /^(c[0-9]+|NO_REPAIR|ABSTAIN)$/;

function fail(path: string): never {
  throw new Error(`公開データの形式が不正です: ${path}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(path);
}

function boolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(path);
}

function number(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(path);
}

function date(value: unknown, path: string): asserts value is string {
  text(value, path);
  if (!Number.isFinite(Date.parse(value))) fail(path);
}

function enumValue(value: unknown, allowed: string[], path: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) fail(path);
}

function validateUsage(value: unknown, path: string): asserts value is Usage {
  const usage = record(value, path);
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"]) {
    if (key === "inputTokens" || key === "outputTokens" || usage[key] !== undefined) {
      number(usage[key], `${path}.${key}`);
      if (!Number.isInteger(usage[key])) fail(`${path}.${key}`);
    }
  }
}

function validateCandidate(value: unknown, path: string): asserts value is Candidate {
  const candidate = record(value, path);
  text(candidate.id, `${path}.id`);
  if (!/^c[0-9]+$/.test(candidate.id)) fail(`${path}.id`);
  text(candidate.context, `${path}.context`);
  const locator = record(candidate.locator, `${path}.locator`);
  enumValue(locator.kind, ["role", "label"], `${path}.locator.kind`);
  if (locator.kind === "role") {
    enumValue(locator.role, ["button", "textbox"], `${path}.locator.role`);
    text(locator.name, `${path}.locator.name`);
  } else {
    text(locator.label, `${path}.locator.label`);
  }
  if (locator.scope !== undefined) text(locator.scope, `${path}.locator.scope`);
}

function validateTrial(value: unknown, path: string): asserts value is TrialResult {
  const trial = record(value, path);
  if (trial.schemaVersion !== 1) fail(`${path}.schemaVersion`);
  for (const key of ["caseId", "familyId", "title", "model", "beforeHtml", "afterHtml", "originalTest", "sourceSha"]) {
    text(trial[key], `${path}.${key}`);
  }
  if (!/^[a-f0-9]{40}$/i.test(trial.sourceSha as string)) fail(`${path}.sourceSha`);
  date(trial.recordedAt, `${path}.recordedAt`);
  enumValue(trial.status, statuses, `${path}.status`);
  enumValue(trial.category, categories, `${path}.category`);
  enumValue(trial.provider, providers, `${path}.provider`);
  if (trial.route !== undefined && (!["vercel-ai-gateway", "openrouter"].includes(String(trial.route)) || trial.provider !== "jev")) fail(`${path}.route`);
  enumValue(trial.split, splits, `${path}.split`);
  enumValue(trial.inference, ["live", "deterministic"], `${path}.inference`);
  boolean(trial.baselinePassed, `${path}.baselinePassed`);
  boolean(trial.repairable, `${path}.repairable`);
  for (const key of ["originalTestPassed", "oraclePassed", "targetCorrect"]) {
    if (trial[key] !== null) boolean(trial[key], `${path}.${key}`);
  }
  if (!Array.isArray(trial.candidates)) fail(`${path}.candidates`);
  trial.candidates.forEach((candidate, i) => validateCandidate(candidate, `${path}.candidates[${i}]`));
  const ids = (trial.candidates as Candidate[]).map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) fail(`${path}.candidates: IDの重複`);
  for (const key of ["decision", "expectedDecision"]) {
    if (trial[key] !== null) {
      text(trial[key], `${path}.${key}`);
      const selected = trial[key] as string;
      if (!choice.test(selected) || (!ids.includes(selected) && !["NO_REPAIR", "ABSTAIN"].includes(selected))) {
        fail(`${path}.${key}`);
      }
    }
  }
  const latency = record(trial.latency, `${path}.latency`);
  for (const key of ["captureMs", "decisionMs", "validationMs", "totalMs"]) {
    number(latency[key], `${path}.latency.${key}`);
  }
  for (const key of ["repairedTest", "error", "reason", "modelVersion"]) {
    if (trial[key] !== undefined) text(trial[key], `${path}.${key}`);
  }
  if (trial.costUsd !== undefined) number(trial.costUsd, `${path}.costUsd`);
  if (trial.usage !== undefined) validateUsage(trial.usage, `${path}.usage`);
  if (trial.confidence !== undefined) {
    number(trial.confidence, `${path}.confidence`);
    if (trial.confidence > 1) fail(`${path}.confidence`);
  }
  if (trial.probabilities !== undefined) {
    const probabilities = record(trial.probabilities, `${path}.probabilities`);
    for (const [key, probability] of Object.entries(probabilities)) {
      if (![...ids, "NO_REPAIR", "ABSTAIN"].includes(key)) fail(`${path}.probabilities.${key}`);
      number(probability, `${path}.probabilities.${key}`);
      if (probability > 1) fail(`${path}.probabilities.${key}`);
    }
  }
}

export function parseDataset(value: unknown): PublicDataset {
  const dataset = record(value, "dataset");
  if (dataset.schemaVersion !== 1) fail("schemaVersion");
  text(dataset.label, "label");
  if (dataset.generatedAt !== null) date(dataset.generatedAt, "generatedAt");
  if (dataset.sourceSha !== null) {
    text(dataset.sourceSha, "sourceSha");
    if (!/^[a-f0-9]{40}$/i.test(dataset.sourceSha)) fail("sourceSha");
  }
  boolean(dataset.publicationApproved, "publicationApproved");
  if (!Array.isArray(dataset.trials)) fail("trials");
  const trials = dataset.trials.map((trial: unknown, i: number) => {
    validateTrial(trial, `trials[${i}]`);
    return trial;
  });
  if (trials.length && dataset.publicationApproved !== true) {
    fail("publicationApproved: 未承認の結果は公開できません");
  }
  const comparison = dataset.comparison === undefined ? undefined : parseComparison(dataset.comparison);
  const sources = new Set(trials.map((trial) => trial.sourceSha));
  if (comparison) {
    validateComparisonTrials(comparison, trials);
    if (dataset.sourceSha !== (sources.size === 1 ? trials[0]!.sourceSha : null)) fail("comparison.sourceSha");
  } else if (sources.size > 1 || (trials.length && dataset.sourceSha !== trials[0]!.sourceSha)) {
    fail("sourceSha: 異なるソースの比較には検証済み provenance が必要です");
  }
  if (trials.length && dataset.generatedAt === null) fail("generatedAt");
  return {
    schemaVersion: 1, label: dataset.label, generatedAt: dataset.generatedAt,
    sourceSha: dataset.sourceSha, publicationApproved: dataset.publicationApproved,
    trials, ...(comparison ? { comparison } : {}),
  };
}

export function describeTrials(trials: TrialResult[]) {
  const evaluated = trials.filter((trial) => trial.oraclePassed !== null && trial.targetCorrect !== null);
  const costs = trials.flatMap((trial) => trial.costUsd === undefined ? [] : [trial.costUsd]);
  return {
    total: trials.length,
    repaired: trials.filter((trial) => trial.status === "repaired").length,
    evaluated: evaluated.length,
    verified: evaluated.filter((trial) => trial.oraclePassed === true && trial.targetCorrect === true).length,
    measuredCosts: costs.length,
    costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
  };
}

export const providerNames = { rule: "ルール", azure: "Azure OpenAI", jev: "Jev" } as const;
export const statusNames = {
  repaired: "修復案を適用",
  rejected: "修復案を拒否",
  abstained: "判断を保留",
  unsupported: "対応範囲外",
  unchanged: "変更なし",
  error: "実行エラー",
} as const;

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(value);
}

export function formatCost(value: number | undefined | null): string {
  if (value === undefined || value === null) return "未記録";
  if (value > 0 && value < 0.000001) return `$${value.toExponential(2)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 9 })}`;
}

export function formatDuration(value: number | null): string {
  if (value === null) return "未記録";
  if (value > 0 && value < 0.01) return `${value.toExponential(2)} ms`;
  return value < 1000 ? `${formatNumber(value)} ms` : `${formatNumber(value / 1000)} 秒`;
}
