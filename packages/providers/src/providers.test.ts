import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBearerTokenProvider } from "@azure/identity";
import { DECISION_INSTRUCTION, decisionContext, type DecisionRequest } from "../../core/src/index.js";
import { BudgetLedger, committedNanos, usdToNanos } from "./budget.js";
import {
  AZURE_TOKEN_SCOPE, DEFAULT_LEDGER_PATH, GATEWAY_JEV_MODEL, OPENROUTER_JEV_MODEL, OPENROUTER_JEV_REVISION, inspectConfiguration, loadConfiguration,
  jevCredentialName, validateConfiguration, verifyFreeOnly, verifyPrivatePath, type ProviderConfiguration,
} from "./configuration.js";
import { createProvider } from "./index.js";
import { azurePayload, buildLiveProvider, gatewayPayload, jevPayload } from "./live.js";

vi.mock("@azure/identity", () => ({
  AzureCliCredential: class {
    constructor(readonly options: unknown) {}
  },
  getBearerTokenProvider: vi.fn(() => async () => "test-only-not-a-real-token"),
}));

const request: DecisionRequest = {
  caseId: "secret-oracle-case-id",
  intent: "Save the profile", operation: "click",
  oldLocator: { kind: "role", role: "button", name: "Save" },
  oldContext: "Profile",
  candidates: [
    { id: "c1", locator: { kind: "role", role: "button", name: "Save" }, context: "Profile" },
  ],
};

function config(): ProviderConfiguration {
  return {
    schemaVersion: 1, ledgerPath: DEFAULT_LEDGER_PATH, budgetUsd: 10,
    approvals: { pricingVerified: true, accessConfirmed: true, publicationApproved: true },
    limits: {
      maxSerializedBytes: 6000, maxInputTokens: 32_000, inputTokenOverhead: 2048,
      maxOutputTokens: 1024, maxResponseBytes: 32_768, timeoutMs: 3000, maxCalls: 500,
    },
    azure: {
      endpoint: "https://example.openai.azure.com", tenantId: "11111111-1111-1111-1111-111111111111",
      deployment: "gpt-5.5", model: "gpt-5.5", modelVersion: "2026-04-24",
      pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 10, fixedUsdPerRequest: 0, verifiedAt: "2026-09-24", source: "test fixture, not a current price" },
    },
    jev: {
      model: "jev-1.13.0",
      pricing: { inputUsdPerMillion: 0.042, outputUsdPerMillion: 0, fixedUsdPerRequest: 0, verifiedAt: "2026-09-24", source: "https://docs.typesafe.ai/models" },
    },
  };
}

function azureResponse(choice = "c1"): Record<string, unknown> {
  return {
    id: "test-response", model: "gpt-5.5-2026-04-24",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ choice }), refusal: null } }],
    usage: {
      prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 20 },
    },
  };
}

function jevResponse(selected = "c1"): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: { decision: { type: "choice", choice: selected, confidence: 0.01, probabilities: { c1: 0.6, NO_REPAIR: 0.3, ABSTAIN: 0.1 } } },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function gatewayConfig(): ProviderConfiguration {
  const base = config();
  return {
    ...base,
    jev: { route: "vercel-ai-gateway", model: GATEWAY_JEV_MODEL, provider: "digitalocean",
      requireFree: true, freeUntil: "2100-01-01T00:00:00Z", pricing: {
      ...base.jev!.pricing, inputUsdPerMillion: 0,
      source: "Mock verified free pricing; not current applicable rates",
    } },
  };
}

function gatewayResponse(): Record<string, unknown> {
  return {
    model: GATEWAY_JEV_MODEL,
    answers: { decision: { type: "choice", choice: "c1", probabilities: { c1: 0.6, NO_REPAIR: 0.3, ABSTAIN: 0.1 } } },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: gatewayMetadata() },
  };
}

function gatewayMetadata() {
  return {
    generationId: "test-generation-id", cost: "0", gatewayCost: "0", surchargeCost: "0", marketCost: "0.0000042",
    routing: { originalModelId: GATEWAY_JEV_MODEL, canonicalSlug: GATEWAY_JEV_MODEL, finalProvider: "digitalocean", totalProviderAttemptCount: 1 },
  };
}

let directory: string;
let ledger: BudgetLedger;

function openRouterConfig(): ProviderConfiguration {
  const base = config();
  return { ...base, jev: { route: "openrouter", model: OPENROUTER_JEV_MODEL, pricing: base.jev!.pricing } };
}

function openRouterResponse(): Record<string, unknown> {
  return {
    ...jevResponse(), model: OPENROUTER_JEV_REVISION, provider: "TypeSafe", id: "gen-test-openrouter",
    usage: { input_tokens: 100, output_tokens: 20, cost: 0.0000021 },
  };
}

beforeEach(async () => {
  directory = resolve(dirname(fileURLToPath(import.meta.url)), `.test-state-${randomUUID()}`);
  await mkdir(directory);
  ledger = new BudgetLedger(resolve(directory, "budget.json"));
  await ledger.initialize();
  vi.stubEnv("TYPESAFE_API_KEY", "test-only-not-a-real-key");
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-only-not-a-real-gateway-key");
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-openrouter-key");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network call"); }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function mockResponse(body: unknown, status = 200) {
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "x-request-id": "azure-test-id", "x-typesafe-request-id": "jev-test-id" },
  }));
  vi.stubGlobal("fetch", transport);
  return transport;
}

describe("persistent budget", () => {
  it("retains a terminal rejection's unknown cost while authorizing only one additional reservation", async () => {
    const entry = await ledger.reserve("jev", 6, 100, 100);
    await ledger.markUnknown(entry.id, "PERMISSION");
    await ledger.authorizeOneAdditionalCall(entry.id, "Test: final HTTP 403 observed; user authorizes one call with retained maximum");
    const restarted = new BudgetLedger(ledger.path);
    expect((await restarted.inspect()).reservations[0]).toMatchObject({
      status: "unknown", maximumNanos: 6_000_000_000, continuation: { maxCalls: 2 },
    });
    expect((await restarted.inspect()).reservations[0]?.actualNanos).toBeUndefined();
    await expect(restarted.reserve("jev", 4.000000001, 100, 100)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const next = await restarted.reserve("jev", 4, 100, 100);
    await restarted.settle(next.id, 1, { inputTokens: 10, outputTokens: 1 });
    expect(committedNanos(await restarted.inspect())).toBe(7_000_000_000);
    await expect(restarted.reserve("azure", 0, 100, 100)).rejects.toMatchObject({ code: "UNRESOLVED_BILLING" });
    await restarted.reconcile(entry.id, 0, "Test: later verified final zero billing and termination");
    expect(committedNanos(await restarted.inspect())).toBe(1_000_000_000);
  });

  it.each(["TIMEOUT", "BOUND_EXCEEDED", "PROVIDER_FAILURE"])("never authorizes continuation for %s", async (code) => {
    const entry = await ledger.reserve("jev", 1, 100, 100);
    await expect(ledger.authorizeOneAdditionalCall(entry.id, "Still active")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await ledger.markUnknown(entry.id, code);
    await expect(ledger.authorizeOneAdditionalCall(entry.id, "Not a verified terminal authentication rejection"))
      .rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await ledger.inspect()).reservations[0]?.continuation).toBeUndefined();
  });

  it("consumes a continuation atomically and rejects malformed continuation records", async () => {
    const entry = await ledger.reserve("jev", 1, 100, 100);
    await ledger.markUnknown(entry.id, "AUTHENTICATION");
    await expect(ledger.authorizeOneAdditionalCall(entry.id, "")).rejects.toThrow();
    await ledger.authorizeOneAdditionalCall(entry.id, "Test: verified terminal 401 and explicit user permission");
    const other = new BudgetLedger(ledger.path);
    const results = await Promise.allSettled([ledger.reserve("jev", 1, 100, 100), other.reserve("jev", 1, 100, 100)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(ledger.authorizeOneAdditionalCall(entry.id, "Cannot ignore the new in-flight request")).rejects.toThrow();
    const snapshot = await ledger.inspect();
    snapshot.reservations[0]!.failureCode = "TIMEOUT";
    await writeFile(ledger.path, JSON.stringify(snapshot));
    await expect(ledger.inspect()).rejects.toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("persists a reservation across instances and blocks Azure and Jev until reconciliation", async () => {
    const entry = await ledger.reserve("azure", 6, 100, 100);
    const restarted = new BudgetLedger(ledger.path);
    expect(committedNanos(await restarted.inspect())).toBe(6_000_000_000);
    await expect(restarted.reserve("jev", 1, 100, 100)).rejects.toMatchObject({ code: "UNRESOLVED_BILLING" });
    await restarted.markUnknown(entry.id, "TIMEOUT");
    await restarted.reconcile(entry.id, 4, "Verified final invoice and terminated request, test evidence");
    await expect(ledger.reserve("jev", 6.000000001, 100, 100)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(ledger.reserve("jev", 6, 100, 100)).resolves.toMatchObject({ status: "reserved" });
  });

  it("serializes concurrent processes/instances with an exclusive filesystem lock", async () => {
    const other = new BudgetLedger(ledger.path);
    const results = await Promise.allSettled([
      ledger.reserve("azure", 1, 100, 10), other.reserve("jev", 1, 100, 10),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await ledger.inspect()).reservations).toHaveLength(1);
  });

  it("never recreates a missing ledger or steals a stale lock", async () => {
    await expect(new BudgetLedger(resolve(directory, "missing.json")).reserve("jev", 1, 1, 1))
      .rejects.toMatchObject({ code: "LEDGER_UNREADABLE" });
    await writeFile(`${ledger.path}.lock`, "old crash lock");
    await expect(ledger.reserve("azure", 1, 1, 1)).rejects.toMatchObject({ code: "LEDGER_LOCKED" });
    expect(await readFile(`${ledger.path}.lock`, "utf8")).toBe("old crash lock");
    await expect(ledger.initialize()).rejects.toMatchObject({ code: "LEDGER_LOCKED" });
  });

  it("validates money, usage bounds, and atomic call limits", async () => {
    expect(() => new BudgetLedger(ledger.path, 11)).toThrow();
    for (const value of [NaN, Infinity, -1]) expect(() => usdToNanos(value)).toThrow();
    const entry = await ledger.reserve("azure", 1, 100, 20, 1);
    await expect(ledger.settle(entry.id, 1.01, { inputTokens: 10, outputTokens: 1 })).rejects.toMatchObject({ code: "BOUND_EXCEEDED" });
    await expect(ledger.settle(entry.id, 0.1, { inputTokens: 101, outputTokens: 1 })).rejects.toMatchObject({ code: "BOUND_EXCEEDED" });
    await ledger.settle(entry.id, 0.1, { inputTokens: 10, outputTokens: 1 });
    await expect(ledger.reserve("jev", 0, 100, 20, 1)).rejects.toMatchObject({ code: "CALL_LIMIT" });
    expect((await readdir(directory)).sort()).toEqual(["budget.json"]);
  });

  it("rejects corrupt ledgers and records reconciled overruns without hiding them", async () => {
    const entry = await ledger.reserve("azure", 1, 100, 20);
    await ledger.reconcile(entry.id, 11, "Externally verified overrun; requires permanent stop");
    await expect(ledger.reserve("jev", 0, 1, 1)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await writeFile(ledger.path, '{"schemaVersion":1,"capNanos":10000000000,"reservations":[{}]}');
    await expect(ledger.inspect()).rejects.toThrow();
  });
});

describe("config and deterministic baseline", () => {
  it("is read-only with no config and rejects public/private-boundary mistakes", async () => {
    expect(await inspectConfiguration()).toMatchObject({ ready: false, networkAttempted: false, providers: { rule: true } });
    await expect(loadConfiguration(resolve(directory, "config.json"))).rejects.toMatchObject({ code: "PRIVATE_PATH_REQUIRED" });
    await expect(verifyPrivatePath(directory)).rejects.toMatchObject({ code: "PRIVATE_PATH_REQUIRED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(["budget.json"]);
  });

  it("rejects unpriced calls, secrets in configuration, aliases, and a second ledger", () => {
    expect(validateConfiguration(config())).toEqual(config());
    expect(() => validateConfiguration({ ...config(), apiKey: "do-not-store" })).toThrow();
    expect(() => validateConfiguration({ ...config(), ledgerPath: resolve(directory, "other.json") })).toThrow();
    expect(() => validateConfiguration({ ...config(), jev: { ...config().jev, model: "jev-latest" } })).toThrow();
    expect(() => validateConfiguration({ ...config(), azure: { ...config().azure, pricing: { inputUsdPerMillion: Infinity } } })).toThrow();
    expect(() => createProvider("azure")).toThrow();
  });

  it("requires an explicit Gateway route, model and free-only policy", () => {
    const gateway = gatewayConfig();
    expect(validateConfiguration(gateway)).toEqual(gateway);
    expect(jevCredentialName(gateway)).toBe("AI_GATEWAY_API_KEY");
    expect(jevCredentialName(config())).toBe("TYPESAFE_API_KEY");
    expect(() => validateConfiguration({ ...gateway, jev: { ...gateway.jev, route: "unverified" } })).toThrow();
    expect(() => validateConfiguration({ ...gateway, jev: { ...gateway.jev, model: "jev-1.13.0" } })).toThrow();
    expect(() => validateConfiguration({ ...gateway, jev: { ...gateway.jev, requireFree: undefined } })).toThrow();
    expect(() => validateConfiguration({ ...gateway, jev: { ...gateway.jev, provider: "unverified" } })).toThrow();
    expect(() => validateConfiguration({ ...gateway, jev: { ...gateway.jev, freeUntil: "2026-09-25" } })).toThrow();
    expect(() => verifyFreeOnly(gateway)).not.toThrow();
    gateway.jev!.pricing.inputUsdPerMillion = 0.042;
    expect(() => verifyFreeOnly(gateway)).toThrowError(expect.objectContaining({ code: "FREE_ONLY" }));
  });

  describe("Vercel Gateway HTTP transport (mock fetch only)", () => {
    it("sends the identical finite-choice task once, pins the upstream and settles reported free cost", async () => {
      const cfg = gatewayConfig();
      const payload = gatewayPayload(request, cfg);
      expect(payload.state).toBe(jevPayload(request).state);
      expect(payload.questions).toEqual(jevPayload(request).questions);
      const transport = mockResponse(gatewayResponse());
      transport.mockImplementation(async (url, init) => {
        expect((await ledger.inspect()).reservations[0]?.status).toBe("reserved");
        expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toEqual({
          "content-type": "application/json", authorization: "Bearer test-only-not-a-real-gateway-key",
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: GATEWAY_JEV_MODEL, providerOptions: { gateway: { only: ["digitalocean"] } },
        });
        return new Response(JSON.stringify(gatewayResponse()), { headers: { "content-type": "application/json" } });
      });
      const result = await buildLiveProvider("jev", cfg, ledger).decide(request);
      expect(result).toMatchObject({
        model: GATEWAY_JEV_MODEL, route: "vercel-ai-gateway", choice: "c1",
        usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0, requestId: "test-generation-id",
      });
      expect(result.modelVersion).toBeUndefined();
      expect(result.confidence).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
      expect((await ledger.inspect()).reservations[0]?.status).toBe("settled");
    });

    it.each(["missing", "invalid", "expired", "deadline"])("blocks %s free-price validity before any reservation", async (kind) => {
      const cfg = gatewayConfig();
      if (cfg.jev?.route !== "vercel-ai-gateway") throw new Error("Invalid test configuration");
      cfg.jev.freeUntil = kind === "missing" ? undefined : kind === "invalid" ? "unverified" : kind === "expired"
        ? "2000-01-01T00:00:00Z" : new Date(Date.now() + 1000).toISOString();
      await expect(buildLiveProvider("jev", cfg, ledger).decide(request)).rejects.toMatchObject({ code: "FREE_NOT_CONFIRMED" });
      expect(fetch).not.toHaveBeenCalled();
      expect((await ledger.inspect()).reservations).toHaveLength(0);
    });

    it("blocks nonzero rates and never substitutes the TypeSafe key", async () => {
      const cfg = gatewayConfig();
      cfg.jev!.pricing.inputUsdPerMillion = 0.042;
      await expect(buildLiveProvider("jev", cfg, ledger).decide(request)).rejects.toMatchObject({ code: "FREE_ONLY" });
      vi.stubEnv("AI_GATEWAY_API_KEY", "");
      await expect(buildLiveProvider("jev", gatewayConfig(), ledger).decide(request)).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
      expect(fetch).not.toHaveBeenCalled();
      expect((await ledger.inspect()).reservations).toHaveLength(0);
    });

    it.each([
      ["missing usage", { ...gatewayResponse(), usage: undefined }],
      ["snake-case usage", { ...gatewayResponse(), usage: { input_tokens: 100, output_tokens: 20 } }],
      ["over-limit usage", { ...gatewayResponse(), usage: { inputTokens: 32_001, outputTokens: 20 } }],
      ["model substitution", { ...gatewayResponse(), model: "jev-1.13.0" }],
      ["missing metadata", { ...gatewayResponse(), providerMetadata: undefined }],
      ["missing billed cost", { ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), gatewayCost: undefined } } }],
      ["unexpected charge", { ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), gatewayCost: "0.01", cost: "0.01" } } }],
      ["unexpected surcharge", { ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), gatewayCost: "0.01", surchargeCost: "0.01" } } }],
      ["invalid cost", { ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), gatewayCost: "-1" } } }],
      ["wrong upstream", { ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), routing: { ...gatewayMetadata().routing, finalProvider: "typesafe-ai" } } } }],
      ["upstream retry", { ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), routing: { ...gatewayMetadata().routing, totalProviderAttemptCount: 2 } } } }],
      ["invalid choice", { ...gatewayResponse(), answers: { decision: { type: "choice", choice: "c999", probabilities: { c1: 1, NO_REPAIR: 0, ABSTAIN: 0 } } } }],
    ])("fails closed on %s and blocks subsequent calls", async (_label, body) => {
      const transport = mockResponse(body);
      const provider = buildLiveProvider("jev", gatewayConfig(), ledger);
      await expect(provider.decide(request)).rejects.toThrow();
      expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
      await expect(provider.decide(request)).rejects.toMatchObject({ code: "UNRESOLVED_BILLING" });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 429, 503])("never retries Gateway HTTP %s or falls back", async (status) => {
      const transport = mockResponse({ error: { message: "private-response-details" } }, status);
      await expect(buildLiveProvider("jev", gatewayConfig(), ledger).decide(request)).rejects.not.toThrow("private-response-details");
      expect(transport).toHaveBeenCalledTimes(1);
      expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
    });

    it("settles the reported debit, not the market-price estimate, when paid use is explicitly allowed", async () => {
      const cfg = gatewayConfig();
      if (cfg.jev?.route !== "vercel-ai-gateway") throw new Error("Invalid test configuration");
      cfg.jev.requireFree = false;
      cfg.jev.pricing.inputUsdPerMillion = 0.042;
      mockResponse({ ...gatewayResponse(), providerMetadata: { gateway: { ...gatewayMetadata(), gatewayCost: "0.0000021", cost: "0.0000021" } } });
      const result = await buildLiveProvider("jev", cfg, ledger).decide(request);
      expect(result.costUsd).toBe(0.0000021);
      expect((await ledger.inspect()).reservations[0]?.status).toBe("settled");
    });
  });

  it("selects deterministic exact matches, abstains on ties, and rejects unrelated candidates", async () => {
    const rule = createProvider("rule");
    expect(await rule.decide(request)).toMatchObject({ choice: "c1", costUsd: 0 });
    const two = { ...request, candidates: [...request.candidates, { ...request.candidates[0]!, id: "c2" }] };
    expect(await rule.decide(two)).toMatchObject({ choice: "ABSTAIN" });
    expect(await rule.decide({ ...request, candidates: [] })).toMatchObject({ choice: "NO_REPAIR" });
    expect(await rule.decide({ ...request, oldContext: "", candidates: [{ id: "c1", locator: { kind: "role", role: "button", name: "Delete" }, context: "" }] }))
      .toMatchObject({ choice: "NO_REPAIR" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("OpenRouter System One HTTP transport (mock fetch only)", () => {
  it("requires the explicit route, namespace and dedicated key", async () => {
    const cfg = openRouterConfig();
    expect(validateConfiguration(cfg)).toEqual(cfg);
    expect(jevCredentialName(cfg)).toBe("OPENROUTER_API_KEY");
    expect(() => validateConfiguration({ ...cfg, jev: { ...cfg.jev, model: "jev-latest" } })).toThrow();
    expect(() => validateConfiguration({ ...cfg, jev: { ...cfg.jev, route: undefined } })).toThrow();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(buildLiveProvider("jev", cfg, ledger).decide(request)).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await ledger.inspect()).reservations).toHaveLength(0);
  });

  it("sends the same task once to OpenRouter and settles reported cost rather than estimated list price", async () => {
    const transport = mockResponse(openRouterResponse());
    const result = await buildLiveProvider("jev", openRouterConfig(), ledger).decide(request);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${process.env.OPENROUTER_API_KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({ ...jevPayload(request), model: OPENROUTER_JEV_MODEL });
    expect(result).toMatchObject({
      choice: "c1", model: OPENROUTER_JEV_REVISION, modelVersion: OPENROUTER_JEV_REVISION,
      route: "openrouter", costUsd: 0.0000021, requestId: "gen-test-openrouter",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect((await ledger.inspect()).reservations[0]).toMatchObject({ status: "settled", actualNanos: usdToNanos(0.0000021) });
  });

  it("does not invent a version or confidence when the response does not contain them", async () => {
    mockResponse({
      ...openRouterResponse(), model: OPENROUTER_JEV_MODEL,
      answers: { decision: { type: "choice", choice: "c1", probabilities: { c1: 1, NO_REPAIR: 0, ABSTAIN: 0 } } },
    });
    const result = await buildLiveProvider("jev", openRouterConfig(), ledger).decide(request);
    expect(result.modelVersion).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  it.each([
    ["missing cost", { ...openRouterResponse(), usage: { input_tokens: 100, output_tokens: 20 } }],
    ["negative cost", { ...openRouterResponse(), usage: { input_tokens: 100, output_tokens: 20, cost: -1 } }],
    ["over-budget cost", { ...openRouterResponse(), usage: { input_tokens: 100, output_tokens: 20, cost: 1 } }],
    ["missing usage", { ...openRouterResponse(), usage: undefined }],
    ["excess usage", { ...openRouterResponse(), usage: { input_tokens: 32_001, output_tokens: 20, cost: 0 } }],
    ["wrong provider", { ...openRouterResponse(), provider: "Unknown" }],
    ["missing generation", { ...openRouterResponse(), id: undefined }],
    ["wrong revision", { ...openRouterResponse(), model: "typesafe/jev-1.13-20990101" }],
    ["invalid answer", { ...openRouterResponse(), answers: {} }],
  ])("retains unknown billing on %s and blocks another call", async (_label, body) => {
    const transport = mockResponse(body);
    const provider = buildLiveProvider("jev", openRouterConfig(), ledger);
    await expect(provider.decide(request)).rejects.toThrow();
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
    await expect(provider.decide(request)).rejects.toMatchObject({ code: "UNRESOLVED_BILLING" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 403, 429, 503])("never retries HTTP %s or falls back to another route", async (status) => {
    const transport = mockResponse({ error: { message: "private-openrouter-detail" } }, status);
    await expect(buildLiveProvider("jev", openRouterConfig(), ledger).decide(request)).rejects.not.toThrow("private-openrouter-detail");
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
  });
});

describe("official SDK transports (mock fetch only)", () => {
  it("shares exact decision context and instruction, with strict finite Azure schema", () => {
    const azure = azurePayload(request, config());
    const jev = jevPayload(request);
    expect(azure.messages).toEqual([
      { role: "system", content: DECISION_INSTRUCTION }, { role: "user", content: decisionContext(request) },
    ]);
    expect(jev.state).toEqual(decisionContext(request));
    expect(jev.questions.decision.instructions).toEqual(DECISION_INSTRUCTION);
    expect(azure.response_format).toMatchObject({
      json_schema: { strict: true, schema: { additionalProperties: false, properties: { choice: { enum: ["c1", "NO_REPAIR", "ABSTAIN"] } } } },
    });
    expect(azure.max_completion_tokens).toBe(1024);
    expect(AZURE_TOKEN_SCOPE).toBe("https://ai.azure.com/.default");
  });

  it("reserves before transport, accounts reasoning/cached usage conservatively, and strips runtime oracle fields", async () => {
    const transport = mockResponse(azureResponse());
    transport.mockImplementation(async (_url, init) => {
      const snapshot = await ledger.inspect();
      expect(snapshot.reservations[0]?.status).toBe("reserved");
      expect(init?.body).not.toContain("secret-oracle");
      expect(init?.body).not.toContain("expectedDecision");
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify(azureResponse()), { headers: { "content-type": "application/json", "x-request-id": "azure-test-id" } });
    });
    const poisoned = {
      ...request, expectedDecision: "secret-oracle",
      candidates: request.candidates.map((candidate) => ({ ...candidate, expectedDecision: "secret-oracle" })),
    };
    const result = await buildLiveProvider("azure", config(), ledger).decide(poisoned);
    expect(result).toMatchObject({
      choice: "c1", model: "gpt-5.5-2026-04-24", requestId: "azure-test-id",
      usage: { inputTokens: 100, outputTokens: 30, reasoningTokens: 20, cachedInputTokens: 40 },
    });
    expect(result.costUsd).toBeCloseTo(0.0005);
    expect(getBearerTokenProvider).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ tenantId: config().azure!.tenantId }),
    }), AZURE_TOKEN_SCOPE);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await ledger.inspect()).reservations[0]?.status).toBe("settled");
  });

  it("uses the pinned Jev SDK and records low confidence without changing the primary decision", async () => {
    const transport = mockResponse(jevResponse());
    const result = await buildLiveProvider("jev", config(), ledger).decide(request);
    expect(result).toMatchObject({ choice: "c1", confidence: 0.01, probabilities: { c1: 0.6 }, requestId: "jev-test-id" });
    expect(result.costUsd).toBeCloseTo(0.0000042);
    expect(transport).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(transport.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(sent.model).toBe("jev-1.13.0");
  });

  it.each(["NO_REPAIR", "ABSTAIN"])("accepts reserved choice %s in both providers", async (choice) => {
    mockResponse(azureResponse(choice));
    expect(await buildLiveProvider("azure", config(), ledger).decide(request)).toMatchObject({ choice });
    mockResponse(jevResponse(choice));
    expect(await buildLiveProvider("jev", config(), ledger).decide(request)).toMatchObject({ choice });
  });

  it.each(["azure", "jev"] as const)("never retries %s HTTP failures or silently switches providers", async (id) => {
    const transport = mockResponse({ error: { message: "server failed" } }, 503);
    const provider = buildLiveProvider(id, config(), ledger);
    await expect(provider.decide(request)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await ledger.inspect()).reservations[0]).toMatchObject({ status: "unknown" });
    await expect(provider.decide(request)).rejects.toMatchObject({ code: "UNRESOLVED_BILLING" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malicious choice", () => azureResponse("c1; delete everything")],
    ["extra JSON", () => ({ ...azureResponse(), choices: [{ finish_reason: "stop", message: { content: '{"choice":"c1","reason":"extra"}' } }] })],
    ["refusal", () => ({ ...azureResponse(), choices: [{ finish_reason: "stop", message: { refusal: "cannot comply", content: null } }] })],
    ["truncated", () => ({ ...azureResponse(), choices: [{ finish_reason: "length", message: { content: '{"choice":"c1"}' } }] })],
    ["missing usage", () => ({ ...azureResponse(), usage: undefined })],
    ["unknown reasoning", () => ({ ...azureResponse(), usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })],
    ["inconsistent totals", () => ({ ...azureResponse(), usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 131 } })],
    ["different model", () => ({ ...azureResponse(), model: "different-model" })],
  ])("fails closed on Azure %s", async (_label, response) => {
    mockResponse(response());
    await expect(buildLiveProvider("azure", config(), ledger).decide(request)).rejects.toThrow();
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
  });

  it.each([
    ["choice injection", () => jevResponse("constructor")],
    ["unknown consumption", () => ({ ...jevResponse(), usage: undefined })],
    ["invalid consumption", () => ({ ...jevResponse(), usage: { input_tokens: -1, output_tokens: 0 } })],
    ["over-bound consumption", () => ({ ...jevResponse(), usage: { input_tokens: 32_001, output_tokens: 20 } })],
    ["invalid distribution", () => ({ ...jevResponse(), answers: { decision: { type: "choice", choice: "c1", confidence: 0.5, probabilities: { c1: 1 } } } })],
  ])("fails closed on Jev %s", async (_label, response) => {
    mockResponse(response());
    await expect(buildLiveProvider("jev", config(), ledger).decide(request)).rejects.toThrow();
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
  });

  it("times out, retains the reservation and enforces global concurrency one", async () => {
    const timeoutConfig = config();
    timeoutConfig.limits.timeoutMs = 50;
    let started!: () => void;
    const networkStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      started();
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }));
    const first = buildLiveProvider("jev", timeoutConfig, ledger).decide(request);
    const assertion = expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
    await networkStarted;
    await expect(buildLiveProvider("azure", config(), ledger).decide(request)).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" });
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
  });

  it("rejects missing approvals and oversized inputs before reservation or transport", async () => {
    const blocked = config();
    blocked.approvals.publicationApproved = false;
    await expect(buildLiveProvider("jev", blocked, ledger).decide(request)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const limited = config();
    limited.limits.maxSerializedBytes = 1;
    await expect(buildLiveProvider("azure", limited, ledger).decide(request)).rejects.toMatchObject({ code: "INPUT_LIMIT" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await ledger.inspect()).reservations).toHaveLength(0);
  });

  it("does not send a request when the next conservative reservation exceeds the cap", async () => {
    const previous = await ledger.reserve("azure", 10, 100, 100);
    await ledger.settle(previous.id, 10, { inputTokens: 100, outputTokens: 100 });
    await expect(buildLiveProvider("jev", config(), ledger).decide(request)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await ledger.inspect()).reservations).toHaveLength(1);
  });

  it("rejects output usage exceeding the visible-plus-reasoning budget", async () => {
    mockResponse({
      ...azureResponse(),
      usage: {
        prompt_tokens: 100, completion_tokens: 1025, total_tokens: 1125,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 1020 },
      },
    });
    await expect(buildLiveProvider("azure", config(), ledger).decide(request)).rejects.toMatchObject({ code: "BOUND_EXCEEDED" });
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
  });

  it("limits response bytes and retains the reservation without a transport retry", async () => {
    const limited = config();
    limited.limits.maxResponseBytes = 1024;
    const transport = mockResponse({ padding: "x".repeat(2048) });
    await expect(buildLiveProvider("jev", limited, ledger).decide(request)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await ledger.inspect()).reservations[0]?.status).toBe("unknown");
  });
});
