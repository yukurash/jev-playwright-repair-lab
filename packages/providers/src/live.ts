import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AzureCliCredential, getBearerTokenProvider } from "@azure/identity";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {
  choicesFor, DECISION_INSTRUCTION, decisionContext, validateChoice,
  type DecisionProvider, type DecisionRequest, type ProviderResult, type Usage,
} from "../../core/src/index.js";
import { BudgetLedger, type Reservation, validateUsage } from "./budget.js";
import {
  AZURE_TOKEN_SCOPE, GATEWAY_JEV_MODEL, JEV_MODEL, jevCredentialName, verifyFreeOnly,
  verifyPrivatePath, type Pricing, type ProviderConfiguration,
} from "./configuration.js";
import { canonicalRequest } from "./decision.js";
import { integer, object, ProviderError, text } from "./errors.js";

let active = false;

export function estimatedCost(pricing: Pricing, input: number, output: number): number {
  const cost = input * pricing.inputUsdPerMillion / 1_000_000
    + output * pricing.outputUsdPerMillion / 1_000_000 + pricing.fixedUsdPerRequest;
  if (!Number.isFinite(cost) || cost < 0) throw new ProviderError("INVALID_COST", "Pricing produced a non-finite cost");
  return cost;
}

export function azurePayload(request: DecisionRequest, config: ProviderConfiguration): ChatCompletionCreateParamsNonStreaming {
  if (!config.azure) throw new ProviderError("MISSING_PROVIDER", "Azure configuration missing");
  return {
    model: config.azure.deployment,
    messages: [
      { role: "system", content: DECISION_INSTRUCTION },
      { role: "user", content: decisionContext(request) },
    ],
    n: 1, stream: false, store: false,
    max_completion_tokens: config.limits.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "repair_choice", strict: true,
        schema: {
          type: "object",
          properties: { choice: { type: "string", enum: choicesFor(request) } },
          required: ["choice"], additionalProperties: false,
        },
      },
    },
  };
}

export function jevPayload(request: DecisionRequest) {
  const criteria: Record<string, null> = Object.fromEntries(choicesFor(request).map((id) => [id, null]));
  return {
    model: JEV_MODEL,
    state: decisionContext(request),
    questions: { decision: choice(DECISION_INSTRUCTION, criteria) },
  };
}

export function gatewayPayload(request: DecisionRequest, config: ProviderConfiguration) {
  const jev = config.jev;
  if (jev?.route !== "vercel-ai-gateway") throw new ProviderError("MISSING_PROVIDER", "Gateway configuration missing");
  return {
    ...jevPayload(request), model: GATEWAY_JEV_MODEL,
    providerOptions: { gateway: { only: [jev.provider] } },
  };
}

function checkBody(body: unknown, config: ProviderConfiguration): number {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > config.limits.maxSerializedBytes) throw new ProviderError("INPUT_LIMIT", "Serialized request exceeds its byte cap");
  // Four tokens per UTF-8 byte plus explicit framing allowance is deliberately pessimistic.
  const conservative = bytes * 4 + config.limits.inputTokenOverhead;
  if (conservative > config.limits.maxInputTokens) {
    throw new ProviderError("INPUT_LIMIT", "Conservative serialized input estimate exceeds its token allowance");
  }
  return config.limits.maxInputTokens;
}

function boundedFetch(expectedUrl: string, config: ProviderConfiguration, signal: AbortSignal): typeof fetch {
  let attempts = 0;
  return async (input, init) => {
    if (++attempts !== 1) throw new ProviderError("RETRY_BLOCKED", "Only one network attempt is permitted");
    const url = input instanceof Request ? input.url : String(input);
    if (url !== expectedUrl || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
      throw new ProviderError("TRANSPORT_MISMATCH", "SDK attempted an unexpected request");
    }
    checkBody(JSON.parse(init.body) as unknown, config);
    const response = await globalThis.fetch(input, { ...init, redirect: "error", signal });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > config.limits.maxResponseBytes) {
            await reader.cancel();
            throw new ProviderError("RESPONSE_LIMIT", "Provider response exceeded its byte cap");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
}

function parseAzure(value: unknown, request: DecisionRequest, config: ProviderConfiguration): Omit<ProviderResult, "latencyMs" | "costUsd"> {
  const response = object(value, "Azure response");
  const model = text(response.model, "response model");
  const azure = config.azure!;
  if (model !== azure.model && model !== `${azure.model}-${azure.modelVersion}`) {
    throw new ProviderError("MODEL_CHANGED", "Azure returned an unexpected model");
  }
  if (!Array.isArray(response.choices) || response.choices.length !== 1) {
    throw new ProviderError("INVALID_RESPONSE", "Expected exactly one Azure choice");
  }
  const item = object(response.choices[0], "Azure choice");
  const message = object(item.message, "Azure message");
  if (message.refusal !== undefined && message.refusal !== null) {
    throw new ProviderError("REFUSAL", "Azure refused the decision");
  }
  if (item.finish_reason !== "stop" || message.tool_calls !== undefined || message.function_call !== undefined) {
    throw new ProviderError("INCOMPLETE_RESPONSE", "Azure did not produce a complete finite decision");
  }
  let content: Record<string, unknown>;
  try {
    content = object(JSON.parse(text(message.content, "Azure content")) as unknown, "choice JSON");
  } catch {
    throw new ProviderError("INVALID_RESPONSE", "Azure did not return a JSON object");
  }
  if (Object.keys(content).length !== 1 || !Object.hasOwn(content, "choice")) {
    throw new ProviderError("INVALID_RESPONSE", "Azure choice JSON contains unexpected fields");
  }
  const rawUsage = object(response.usage, "Azure usage");
  const inputTokens = integer(rawUsage.prompt_tokens, "prompt_tokens", 1);
  const outputTokens = integer(rawUsage.completion_tokens, "completion_tokens");
  if (integer(rawUsage.total_tokens, "total_tokens") !== inputTokens + outputTokens) {
    throw new ProviderError("INVALID_USAGE", "Azure token totals are inconsistent");
  }
  const outputDetails = object(rawUsage.completion_tokens_details, "completion token details");
  const inputDetails = object(rawUsage.prompt_tokens_details, "prompt token details");
  const usage = validateUsage({
    inputTokens, outputTokens,
    reasoningTokens: integer(outputDetails.reasoning_tokens, "reasoning_tokens"),
    cachedInputTokens: integer(inputDetails.cached_tokens, "cached_tokens"),
  });
  return { choice: validateChoice(content.choice, request), model, modelVersion: azure.modelVersion, usage };
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderError("INVALID_RESPONSE", "Probability/confidence is outside [0,1]");
  }
  return value;
}

function parseJevAnswer(value: unknown, request: DecisionRequest, requireConfidence: boolean) {
  const answers = object(value, "Jev answers");
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "decision")) {
    throw new ProviderError("INVALID_RESPONSE", "Unexpected Jev answer keys");
  }
  const answer = object(answers.decision, "Jev choice");
  if (answer.type !== "choice") throw new ProviderError("INVALID_RESPONSE", "Jev did not return a Choice");
  const distribution = object(answer.probabilities, "Jev probabilities");
  const allowed = choicesFor(request);
  if (Object.keys(distribution).length !== allowed.length || Object.keys(distribution).some((id) => !allowed.includes(id))) {
    throw new ProviderError("INVALID_RESPONSE", "Jev probabilities differ from the finite choice set");
  }
  const probabilities = Object.fromEntries(allowed.map((id) => [id, probability(distribution[id])]));
  if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.001) {
    throw new ProviderError("INVALID_RESPONSE", "Jev probabilities do not sum to one");
  }
  return {
    choice: validateChoice(answer.choice, request), probabilities,
    ...(requireConfidence || answer.confidence !== undefined ? { confidence: probability(answer.confidence) } : {}),
  };
}

function parseJev(value: unknown, request: DecisionRequest): Omit<ProviderResult, "latencyMs" | "costUsd"> {
  const response = object(value, "Jev response");
  if (response.model !== JEV_MODEL) throw new ProviderError("MODEL_CHANGED", "Jev returned a different model version");
  const rawUsage = object(response.usage, "Jev usage");
  const usage = validateUsage({
    inputTokens: integer(rawUsage.input_tokens, "input_tokens", 1), outputTokens: rawUsage.output_tokens,
  });
  return {
    ...parseJevAnswer(response.answers, request, true), model: JEV_MODEL, modelVersion: JEV_MODEL, usage,
  };
}

function gatewayCost(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new ProviderError("INVALID_COST", "Gateway must report a finite nonnegative decimal-string cost");
  }
  return Number(value);
}

function parseGateway(value: unknown, request: DecisionRequest, config: ProviderConfiguration): Omit<ProviderResult, "latencyMs"> {
  const jev = config.jev;
  if (jev?.route !== "vercel-ai-gateway") throw new ProviderError("MISSING_PROVIDER", "Gateway configuration missing");
  const response = object(value, "Gateway response");
  if (response.model !== GATEWAY_JEV_MODEL) throw new ProviderError("MODEL_CHANGED", "Gateway returned a different model");
  const metadata = object(object(response.providerMetadata, "Gateway metadata").gateway, "Gateway metadata");
  const routing = object(metadata.routing, "Gateway routing");
  if (routing.originalModelId !== GATEWAY_JEV_MODEL || routing.canonicalSlug !== GATEWAY_JEV_MODEL ||
      routing.finalProvider !== jev.provider) {
    throw new ProviderError("ROUTE_CHANGED", "Gateway returned an unexpected model or upstream provider");
  }
  if (routing.totalProviderAttemptCount !== undefined && integer(routing.totalProviderAttemptCount, "upstream attempts", 1) !== 1) {
    throw new ProviderError("RETRY_BLOCKED", "Gateway reported multiple upstream attempts; inspect raw routing metadata");
  }
  const rawUsage = object(response.usage, "Gateway usage");
  const usage = validateUsage({
    inputTokens: integer(rawUsage.inputTokens, "inputTokens", 1),
    outputTokens: integer(rawUsage.outputTokens, "outputTokens"),
  });
  const costUsd = gatewayCost(metadata.gatewayCost);
  const inferenceCost = gatewayCost(metadata.cost);
  const surcharge = gatewayCost(metadata.surchargeCost);
  if (costUsd < inferenceCost || costUsd < surcharge) throw new ProviderError("INVALID_COST", "Gateway cost metadata is inconsistent");
  if (jev.requireFree && (costUsd !== 0 || inferenceCost !== 0 || surcharge !== 0)) {
    throw new ProviderError("UNEXPECTED_CHARGE", "Gateway reported a charge despite the free-only policy; reconciliation required");
  }
  return {
    ...parseJevAnswer(response.answers, request, false), model: GATEWAY_JEV_MODEL,
    route: "vercel-ai-gateway", usage, costUsd, requestId: text(metadata.generationId, "Gateway generation ID"),
  };
}

function failureCode(error: unknown): string {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof Error && "status" in error) {
    if (error.status === 401) return "AUTHENTICATION";
    if (error.status === 403) return "PERMISSION";
    if (error.status === 429) return "RATE_LIMIT";
  }
  return "PROVIDER_FAILURE";
}

async function recordRaw(directory: string | undefined, reservation: Reservation, data: unknown): Promise<void> {
  if (!directory) return;
  await verifyPrivatePath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(resolve(directory, `${reservation.id}.json`), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ reservationId: reservation.id, provider: reservation.provider, response: data }));
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Internal construction seam permits transport-only tests without private files or credentials. */
export function buildLiveProvider(
  id: "azure" | "jev",
  config: ProviderConfiguration,
  ledger = new BudgetLedger(config.ledgerPath, config.budgetUsd),
): DecisionProvider {
  return {
    id,
    async decide(input) {
      const request = canonicalRequest(input);
      const settings = id === "azure" ? config.azure : config.jev;
      if (!settings) throw new ProviderError("MISSING_PROVIDER", "Requested provider is not configured");
      if (Object.values(config.approvals).some((approved) => approved !== true)) {
        throw new ProviderError("APPROVAL_REQUIRED", "Pricing, access, and publication approval are required before a live call");
      }
      const gateway = id === "jev" && config.jev?.route === "vercel-ai-gateway";
      const credentialName = jevCredentialName(config);
      if (id === "jev") verifyFreeOnly(config);
      if (id === "jev" && !process.env[credentialName]?.trim()) {
        throw new ProviderError("MISSING_CREDENTIAL", `${credentialName} is missing`);
      }
      const body = id === "azure" ? azurePayload(request, config) : gateway ? gatewayPayload(request, config) : jevPayload(request);
      const inputTokenLimit = checkBody(body, config);
      if (id === "jev" && inputTokenLimit > 32_000) {
        throw new ProviderError("INPUT_LIMIT", "Jev's single-question context allowance must be at most 32,000 tokens");
      }
      if (active) throw new ProviderError("CONCURRENCY_LIMIT", "Only one live decision may run at a time");
      active = true;
      let reservation: Reservation | undefined;
      const started = performance.now();
      try {
        await verifyPrivatePath(config.ledgerPath);
        const snapshot = await ledger.inspect();
        if (snapshot.reservations.length >= config.limits.maxCalls) throw new ProviderError("CALL_LIMIT", "Shared call limit reached");
        reservation = await ledger.reserve(
          id, estimatedCost(settings.pricing, inputTokenLimit, config.limits.maxOutputTokens),
          inputTokenLimit, config.limits.maxOutputTokens, config.limits.maxCalls,
        );
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ProviderError("TIMEOUT", "Decision timeout; billing must be reconciled"));
          }, config.limits.timeoutMs);
        });
        let raw: unknown;
        let requestId: string | undefined;
        try {
          const operation = async () => {
            if (id === "azure") {
              const azure = config.azure!;
              const baseURL = `${azure.endpoint}/openai/v1/`;
              const credential = new AzureCliCredential({ tenantId: azure.tenantId, processTimeoutInMs: config.limits.timeoutMs });
              const client = new OpenAI({
                baseURL,
                apiKey: getBearerTokenProvider(credential, AZURE_TOKEN_SCOPE),
                organization: null, project: null,
                maxRetries: 0, timeout: config.limits.timeoutMs, logLevel: "off",
                fetch: boundedFetch(`${baseURL}chat/completions`, config, controller.signal),
              });
              const result = await client.chat.completions.create(azurePayload(request, config), {
                maxRetries: 0, timeout: config.limits.timeoutMs, signal: controller.signal,
              }).withResponse();
              return { raw: result.data as unknown, requestId: result.request_id ?? undefined };
            }
            if (gateway) {
              verifyFreeOnly(config);
              const url = "https://ai-gateway.vercel.sh/v1/evaluate";
              const response = await boundedFetch(url, config, controller.signal)(url, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY!}` },
                body: JSON.stringify(body),
              });
              const responseText = await response.text();
              if (!response.ok) {
                await recordRaw(config.rawResponseDirectory, reservation!, { status: response.status, body: responseText });
                const code = response.status === 401 ? "AUTHENTICATION" : response.status === 403 ? "PERMISSION"
                  : response.status === 429 ? "RATE_LIMIT" : "PROVIDER_FAILURE";
                throw new ProviderError(code, "Gateway HTTP request failed");
              }
              return { raw: JSON.parse(responseText) as unknown, requestId: undefined };
            }
            const client = new TypeSafeClient({
              apiKey: process.env.TYPESAFE_API_KEY!,
              baseURL: "https://api.typesafe.ai", defaultModel: JEV_MODEL,
              retry: { maxRetries: 0 }, timeout: config.limits.timeoutMs, logLevel: "off",
              fetch: boundedFetch("https://api.typesafe.ai/v1/systemone", config, controller.signal),
            });
            const result = await client.systemOne(jevPayload(request), {
              retry: { maxRetries: 0 }, timeout: config.limits.timeoutMs, signal: controller.signal,
            }).withResponse();
            return { raw: result.data as unknown, requestId: result.requestId };
          };
          ({ raw, requestId } = await Promise.race([operation(), timeout]));
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
        await recordRaw(config.rawResponseDirectory, reservation, raw);
        const parsed = id === "azure" ? parseAzure(raw, request, config) : gateway ? parseGateway(raw, request, config) : parseJev(raw, request);
        const usage: Usage = parsed.usage!;
        // Cached tokens are charged at the verified full input rate: never assume a discount.
        const costUsd = "costUsd" in parsed && typeof parsed.costUsd === "number"
          ? parsed.costUsd : estimatedCost(settings.pricing, usage.inputTokens, usage.outputTokens);
        await ledger.settle(reservation.id, costUsd, usage);
        return { ...parsed, latencyMs: performance.now() - started, costUsd, ...(requestId ? { requestId } : {}) };
      } catch (error) {
        const code = failureCode(error);
        if (reservation) {
          try {
            await ledger.markUnknown(reservation.id, code);
          } catch {
            throw new ProviderError("LEDGER_UNCERTAIN", "Reservation retained; stop and inspect the private ledger before any further call", reservation.id);
          }
        }
        throw new ProviderError(code, reservation
          ? "Decision failed; maximum reservation retained and all live calls blocked pending explicit reconciliation"
          : "Decision stopped before network inference", reservation?.id);
      } finally {
        active = false;
      }
    },
  };
}
