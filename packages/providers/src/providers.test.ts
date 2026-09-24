import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBearerTokenProvider } from "@azure/identity";
import { DECISION_INSTRUCTION, decisionContext, type DecisionRequest } from "../../core/src/index.js";
import { BudgetLedger, committedNanos, usdToNanos } from "./budget.js";
import {
  AZURE_TOKEN_SCOPE, DEFAULT_LEDGER_PATH, inspectConfiguration, loadConfiguration,
  validateConfiguration, verifyPrivatePath, type ProviderConfiguration,
} from "./configuration.js";
import { createProvider } from "./index.js";
import { azurePayload, buildLiveProvider, jevPayload } from "./live.js";

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

let directory: string;
let ledger: BudgetLedger;

beforeEach(async () => {
  directory = resolve(dirname(fileURLToPath(import.meta.url)), `.test-state-${randomUUID()}`);
  await mkdir(directory);
  ledger = new BudgetLedger(resolve(directory, "budget.json"));
  await ledger.initialize();
  vi.stubEnv("TYPESAFE_API_KEY", "test-only-not-a-real-key");
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
