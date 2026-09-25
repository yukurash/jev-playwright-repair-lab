import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { blocksReservation, BudgetLedger, committedNanos } from "./budget.js";
import { integer, nonnegative, object, ProviderError, text } from "./errors.js";

export const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const PRIVATE_ROOT = resolve(PUBLIC_ROOT, "..", "jev-playwright-repair-lab-private");
export const DEFAULT_LEDGER_PATH = resolve(PRIVATE_ROOT, "budget.json");
export const AZURE_TOKEN_SCOPE = "https://ai.azure.com/.default";
export const JEV_MODEL = "jev-1.13.0";
export const GATEWAY_JEV_MODEL = "typesafe-ai/jev";
export const OPENROUTER_JEV_MODEL = "typesafe/jev-1.13";
export const OPENROUTER_JEV_REVISION = "typesafe/jev-1.13-20260917";

export interface Pricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  fixedUsdPerRequest: number;
  source: string;
  verifiedAt: string;
}

export interface ProviderConfiguration {
  schemaVersion: 1;
  ledgerPath: string;
  budgetUsd: number;
  approvals: { pricingVerified: boolean; accessConfirmed: boolean; publicationApproved: boolean };
  limits: {
    maxSerializedBytes: number;
    maxInputTokens: number;
    inputTokenOverhead: number;
    maxOutputTokens: number;
    maxResponseBytes: number;
    timeoutMs: number;
    maxCalls: number;
  };
  azure?: {
    endpoint: string;
    tenantId: string;
    deployment: "gpt-5.5";
    model: "gpt-5.5";
    modelVersion: "2026-04-24";
    pricing: Pricing;
  };
  jev?: (
    | { route?: "typesafe"; model: typeof JEV_MODEL }
    | { route: "openrouter"; model: typeof OPENROUTER_JEV_MODEL }
    | {
      route: "vercel-ai-gateway"; model: typeof GATEWAY_JEV_MODEL;
      provider: "typesafe-ai" | "digitalocean"; requireFree: boolean; freeUntil?: string;
    }
  ) & { pricing: Pricing };
  rawResponseDirectory?: string;
}

function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ProviderError("INVALID_CONFIGURATION", `${name} contains unsupported fields; credentials must never be stored in config`);
  }
}

function pricing(value: unknown): Pricing {
  const data = object(value, "pricing");
  keys(data, ["inputUsdPerMillion", "outputUsdPerMillion", "fixedUsdPerRequest", "source", "verifiedAt"], "pricing");
  const verifiedAt = text(data.verifiedAt, "pricing.verifiedAt");
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new ProviderError("INVALID_CONFIGURATION", "Invalid pricing verification date");
  return {
    inputUsdPerMillion: nonnegative(data.inputUsdPerMillion, "inputUsdPerMillion"),
    outputUsdPerMillion: nonnegative(data.outputUsdPerMillion, "outputUsdPerMillion"),
    fixedUsdPerRequest: nonnegative(data.fixedUsdPerRequest, "fixedUsdPerRequest"),
    source: text(data.source, "pricing.source"),
    verifiedAt,
  };
}

function outsidePublic(path: string): void {
  const rel = relative(PUBLIC_ROOT, path);
  if (!isAbsolute(path) || (!rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new ProviderError("PRIVATE_PATH_REQUIRED", "Configuration and raw records must be outside the public repository");
  }
}

export async function verifyPrivatePath(path: string): Promise<void> {
  outsidePublic(path);
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      outsidePublic(resolve(await realpath(ancestor), ...suffix));
      return;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

export function validateConfiguration(value: unknown): ProviderConfiguration {
  const data = object(value, "configuration");
  keys(data, ["schemaVersion", "ledgerPath", "budgetUsd", "approvals", "limits", "azure", "jev", "rawResponseDirectory"], "configuration");
  if (data.schemaVersion !== 1) throw new ProviderError("INVALID_CONFIGURATION", "Expected configuration schemaVersion 1");
  const ledgerPath = text(data.ledgerPath, "ledgerPath");
  if (!isAbsolute(ledgerPath) || resolve(ledgerPath) !== DEFAULT_LEDGER_PATH) {
    throw new ProviderError("INVALID_CONFIGURATION", "All live calls must use the project's one fixed private budget.json ledger");
  }
  const budgetUsd = nonnegative(data.budgetUsd, "budgetUsd");
  if (budgetUsd <= 0 || budgetUsd > 10) throw new ProviderError("INVALID_CONFIGURATION", "Budget must be greater than zero and at most USD 10");
  const approvals = object(data.approvals, "approvals");
  keys(approvals, ["pricingVerified", "accessConfirmed", "publicationApproved"], "approvals");
  for (const field of ["pricingVerified", "accessConfirmed", "publicationApproved"]) {
    if (typeof approvals[field] !== "boolean") throw new ProviderError("INVALID_CONFIGURATION", "Approval flags must be explicit booleans");
  }
  const limits = object(data.limits, "limits");
  keys(limits, ["maxSerializedBytes", "maxInputTokens", "inputTokenOverhead", "maxOutputTokens", "maxResponseBytes", "timeoutMs", "maxCalls"], "limits");
  const result: ProviderConfiguration = {
    schemaVersion: 1, ledgerPath, budgetUsd,
    approvals: {
      pricingVerified: approvals.pricingVerified as boolean,
      accessConfirmed: approvals.accessConfirmed as boolean,
      publicationApproved: approvals.publicationApproved as boolean,
    },
    limits: {
      maxSerializedBytes: integer(limits.maxSerializedBytes, "maxSerializedBytes", 1, 100_000),
      maxInputTokens: integer(limits.maxInputTokens, "maxInputTokens", 1, 1_000_000),
      inputTokenOverhead: integer(limits.inputTokenOverhead, "inputTokenOverhead", 1024, 100_000),
      maxOutputTokens: integer(limits.maxOutputTokens, "maxOutputTokens", 16, 16_384),
      maxResponseBytes: integer(limits.maxResponseBytes, "maxResponseBytes", 1024, 1_048_576),
      timeoutMs: integer(limits.timeoutMs, "timeoutMs", 1, 120_000),
      maxCalls: integer(limits.maxCalls, "maxCalls", 1, 1000),
    },
  };
  if (data.azure !== undefined) {
    const azure = object(data.azure, "azure");
    keys(azure, ["endpoint", "tenantId", "deployment", "model", "modelVersion", "pricing"], "azure");
    const endpoint = text(azure.endpoint, "azure.endpoint");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
        !/^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com)$/i.test(url.hostname) ||
        !["", "/"].includes(url.pathname)) {
      throw new ProviderError("INVALID_CONFIGURATION", "Azure endpoint must be a public-cloud Azure resource HTTPS origin");
    }
    if (azure.deployment !== "gpt-5.5" || azure.model !== "gpt-5.5" || azure.modelVersion !== "2026-04-24") {
      throw new ProviderError("MODEL_CHANGED", "Only the already approved GPT-5.5 deployment/version is allowed");
    }
    const tenantId = text(azure.tenantId, "azure.tenantId");
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new ProviderError("INVALID_CONFIGURATION", "Azure tenantId must be an explicit tenant UUID");
    }
    result.azure = { endpoint: url.origin, tenantId, deployment: azure.deployment, model: azure.model, modelVersion: azure.modelVersion, pricing: pricing(azure.pricing) };
  }
  if (data.jev !== undefined) {
    const jev = object(data.jev, "jev");
    const gateway = jev.route === "vercel-ai-gateway";
    const openrouter = jev.route === "openrouter";
    keys(jev, gateway ? ["route", "model", "provider", "requireFree", "freeUntil", "pricing"] : ["route", "model", "pricing"], "jev");
    if (jev.route !== undefined && jev.route !== "typesafe" && !gateway && !openrouter) {
      throw new ProviderError("INVALID_CONFIGURATION", "Unknown Jev route");
    }
    if (jev.model !== (gateway ? GATEWAY_JEV_MODEL : openrouter ? OPENROUTER_JEV_MODEL : JEV_MODEL)) {
      throw new ProviderError("MODEL_CHANGED", "Jev model must match its explicitly configured route");
    }
    const rates = pricing(jev.pricing);
    if (rates.outputUsdPerMillion !== 0) {
      throw new ProviderError("UNVERIFIED_BILLING", "Jev output has no server token cap; this adapter requires verified input-only billing");
    }
    if (gateway) {
      if (typeof jev.requireFree !== "boolean") throw new ProviderError("INVALID_CONFIGURATION", "Gateway requireFree must be explicit");
      if (jev.provider !== "typesafe-ai" && jev.provider !== "digitalocean") {
        throw new ProviderError("INVALID_CONFIGURATION", "Gateway must restrict routing to one explicitly selected Jev provider");
      }
      if (jev.freeUntil !== undefined && (typeof jev.freeUntil !== "string" ||
          !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(jev.freeUntil) || !Number.isFinite(Date.parse(jev.freeUntil)))) {
        throw new ProviderError("INVALID_CONFIGURATION", "Free-pricing expiry requires an unambiguous timestamp with time zone");
      }
      result.jev = {
        route: "vercel-ai-gateway", model: GATEWAY_JEV_MODEL, provider: jev.provider,
        requireFree: jev.requireFree, pricing: rates,
        ...(typeof jev.freeUntil === "string" ? { freeUntil: jev.freeUntil } : {}),
      };
    } else if (openrouter) {
      result.jev = { route: "openrouter", model: OPENROUTER_JEV_MODEL, pricing: rates };
    } else {
      result.jev = { model: JEV_MODEL, pricing: rates, ...(jev.route === "typesafe" ? { route: "typesafe" as const } : {}) };
    }
  }
  if (data.rawResponseDirectory !== undefined) {
    result.rawResponseDirectory = text(data.rawResponseDirectory, "rawResponseDirectory");
    outsidePublic(result.rawResponseDirectory);
  }
  return result;
}

export async function loadConfiguration(path: string): Promise<ProviderConfiguration> {
  await verifyPrivatePath(path);
  const configuration = validateConfiguration(JSON.parse(await readFile(path, "utf8")) as unknown);
  await verifyPrivatePath(configuration.ledgerPath);
  if (configuration.rawResponseDirectory) await verifyPrivatePath(configuration.rawResponseDirectory);
  return configuration;
}

export interface ConfigurationInspection {
  ready: boolean;
  networkAttempted: false;
  issues: string[];
  providers: { rule: true; azure: boolean; jev: boolean };
  budget?: { capUsd: number; committedUsd: number; calls: number; unresolved: number; retainedMaximumUsd: number; authorizedContinuations: number };
}

export function jevCredentialName(config: ProviderConfiguration): "AI_GATEWAY_API_KEY" | "OPENROUTER_API_KEY" | "TYPESAFE_API_KEY" {
  return config.jev?.route === "vercel-ai-gateway" ? "AI_GATEWAY_API_KEY"
    : config.jev?.route === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
}

export function verifyFreeOnly(config: ProviderConfiguration): void {
  const jev = config.jev;
  if (jev?.route === "vercel-ai-gateway" && jev.requireFree) {
    if (jev.pricing.inputUsdPerMillion !== 0 || jev.pricing.outputUsdPerMillion !== 0 || jev.pricing.fixedUsdPerRequest !== 0) {
      throw new ProviderError("FREE_ONLY", "Free-only Gateway calls require verified zero applicable rates, not assumed promotional pricing");
    }
    const expiresAt = jev.freeUntil ? Date.parse(jev.freeUntil) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + config.limits.timeoutMs) {
      throw new ProviderError("FREE_NOT_CONFIRMED", "Verified free-pricing validity must cover the complete request deadline");
    }
  }
}

/** Read-only: no credential acquisition, model listing, model call, or file creation. */
export async function inspectConfiguration(path?: string): Promise<ConfigurationInspection> {
  const report: ConfigurationInspection = {
    ready: false, networkAttempted: false, issues: [], providers: { rule: true, azure: false, jev: false },
  };
  if (!path) {
    report.issues.push("NO_PRIVATE_CONFIG: rule baseline only");
    return report;
  }
  try {
    const config = await loadConfiguration(path);
    for (const [flag, approved] of Object.entries(config.approvals)) {
      if (!approved) report.issues.push(`APPROVAL_REQUIRED: ${flag}`);
    }
    report.providers.azure = !!config.azure;
    const credentialName = jevCredentialName(config);
    report.providers.jev = !!config.jev && !!process.env[credentialName]?.trim();
    if (config.jev && !report.providers.jev) report.issues.push(`${credentialName}_MISSING`);
    try {
      verifyFreeOnly(config);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      report.issues.push(error.code);
    }
    if (!config.azure && !config.jev) report.issues.push("NO_LIVE_PROVIDER_CONFIGURED");
    const snapshot = await new BudgetLedger(config.ledgerPath, config.budgetUsd).inspect();
    report.budget = {
      capUsd: snapshot.capNanos / 1_000_000_000,
      committedUsd: committedNanos(snapshot) / 1_000_000_000,
      calls: snapshot.reservations.length,
      unresolved: snapshot.reservations.filter((entry) => entry.status !== "settled").length,
      retainedMaximumUsd: snapshot.reservations.filter((entry) => entry.status !== "settled")
        .reduce((sum, entry) => sum + entry.maximumNanos, 0) / 1_000_000_000,
      authorizedContinuations: snapshot.reservations.filter((entry) =>
        entry.status !== "settled" && !blocksReservation(entry, snapshot.reservations.length)).length,
    };
    if (snapshot.reservations.some((entry) => blocksReservation(entry, snapshot.reservations.length))) report.issues.push("UNRESOLVED_BILLING");
    if (report.budget.committedUsd >= report.budget.capUsd) report.issues.push("BUDGET_EXHAUSTED");
    if (report.budget.calls >= config.limits.maxCalls) report.issues.push("CALL_LIMIT");
    if (await access(`${config.ledgerPath}.lock`).then(() => true, () => false)) report.issues.push("LEDGER_LOCKED");
    report.ready = report.issues.length === 0;
  } catch (error) {
    report.issues.push(error instanceof ProviderError ? error.code : "CONFIGURATION_UNREADABLE");
  }
  return report;
}
