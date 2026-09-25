# Decision providers and the private budget ledger

Only local Node.js code calls models. The public demo, CI, and the rule provider do
not call model services. There is no provider failover, inferred answer, synthetic
usage, or automatic retry. All examples below are configuration instructions,
**not evidence that a live call or access check has succeeded**.

## Public TypeScript API

```ts
import {
  createProvider, loadConfiguration, inspectConfiguration, BudgetLedger,
  type ProviderConfiguration,
} from "@repair-lab/providers";

const rule = createProvider("rule");
const config: ProviderConfiguration = await loadConfiguration(absolutePrivateConfigPath);
const provider = createProvider("azure", config); // or "jev"
const result = await provider.decide(request);
```

- `createProvider(id: ProviderId, config?: ProviderConfiguration): DecisionProvider`
  implements the `@repair-lab/core` contract.
- `loadConfiguration(path: string): Promise<ProviderConfiguration>` reads an
  explicitly selected file outside the public repository, rejects unknown fields,
  validates prices and paths, and acquires no credentials.
- `inspectConfiguration(path?: string): Promise<ConfigurationInspection>` is a
  **read-only doctor**: no model listing, credential acquisition, network requests,
  directory creation, initialization, or charge. Without a path it reports
  rule-only readiness. It reports approval issues, environment-key presence
  (never its value), budget totals, unresolved reservations, locks, and call limits.
  `ready` means local prerequisites only; it does not prove live access, current
  billing, model availability, or structured-output compatibility.
- `BudgetLedger(path, capUsd = 10)` exposes `initialize()`, `inspect()`,
  `reserve(provider, maximumUsd, inputTokenLimit, outputTokenLimit, maxCalls?)`,
  `settle(id, actualUsd, usage)`, `markUnknown(id, code)`, and
  `reconcile(id, actualUsd, evidence)`, and the explicitly authorized
  `authorizeOneAdditionalCall(id, terminalEvidence)` or bounded-batch
  `authorizeAdditionalCalls(id, count, terminalEvidence)` described below.
- `ProviderError` has `code` and optional `reservationId`. Error messages do not
  forward provider response bodies, endpoint names, keys, or SDK exception text.
- `DEFAULT_LEDGER_PATH`, `AZURE_TOKEN_SCOPE`, `JEV_MODEL`, `MAX_BUDGET_USD`,
  `committedNanos`, and the configuration/ledger types are also exported.

There is deliberately no unbudgeted smoke-test method. A live smoke test must use
the same `createProvider(...).decide(...)` path.

## Identical decision task

All three providers receive the same request. A strict allowlist rebuilds its
intent, operation, old locator/context, and candidate IDs/locators/contexts before
passing it to core `decisionContext`. `caseId`, runtime-added oracle properties,
and evaluation labels are not serialized. Input page text remains untrusted data.

Azure and Jev use core `DECISION_INSTRUCTION` without provider-specific hints.
Their allowed decisions are the candidate IDs plus `NO_REPAIR` and `ABSTAIN`.
No explanation or replacement code is requested. Any out-of-set choice,
unexpected answer shape, refusal, incomplete result, model mismatch, or missing
usage is an error, **not** an abstention or successful result.

### Rule baseline: `deterministic-lexical-v1`

Filter candidates by operation-compatible control kind. Rank by:

1. Normalized exact accessible-name/label equality: 4 points.
2. Word-set Jaccard overlap between the old name plus intent and candidate name:
   up to 2 points.
3. Word-set Jaccard overlap between old and candidate context: up to 1 point.
4. Exact nonempty old scope match: 1 point.

Normalization is NFKC, lowercase, and trimming; words are Unicode letter/number
runs. No compatible candidate or a zero top score returns `NO_REPAIR`; equal top
scores return `ABSTAIN`; otherwise choose the top candidate. Ties are never broken
using a case ID, an oracle, or arbitrary candidate order. This intentionally simple
lexical baseline is not claimed to be a semantic repair system.

### Azure GPT-5.5

The official `openai@7.17.0` client calls
`https://<resource>.openai.azure.com/openai/v1/chat/completions` (the documented
`services.ai.azure.com` resource-origin form is also accepted).
`@azure/identity@4.13.3` supplies `AzureCliCredential` with an explicit tenant and
`getBearerTokenProvider(..., "https://ai.azure.com/.default")`.

Use the already approved **deployment/model `gpt-5.5`, version `2026-04-24`**.
This adapter rejects configuration that substitutes a different deployment/model;
it does not provision resources, change deployment settings, or silently select
another model. Reported response models must match the selected model or its
dated version. `modelVersion` records the configured, externally verified
deployment version; an undated response name is not independent version proof.

Chat completions use `response_format: { type: "json_schema", json_schema: {
strict: true, ... } }` with one `choice` property, a finite string enum,
`required: ["choice"]`, and `additionalProperties: false`. There is one completion,
no streaming, no tools, and `store: false`. No reasoning-effort setting is guessed
or changed. `max_completion_tokens` bounds visible output **and reasoning tokens**.
The adapter requires valid prompt/completion/total token counts, reasoning token
details, and cached-input details. Cached input is conservatively costed at the
full configured input rate; reasoning is included in completion usage, not billed
twice.

### Jev Choice

The official `@typesafe-ai/sdk@0.6.0` client sends one `choice(...)` question to
`https://api.typesafe.ai/v1/systemone`, explicitly pinned to `jev-1.13.0`.
`state` is the same serialized core context; the question's instructions are the
same instruction, and criteria map every allowed decision to `null`.

The result records Choice, full probabilities, confidence, usage, returned model,
and the available request ID. Probability keys/ranges/sum and confidence range
are validated. **Confidence never changes the primary decision or triggers a
threshold/fallback. It is descriptive, not a measured correctness probability.**

The current official model documentation says input tokens are billed and output
tokens are free. Jev has no documented `max_output_tokens` request parameter.
Therefore this adapter requires a verified zero output-token price, bounds the
finite choice set to 255 options (253 candidates plus two reserved choices), limits
response bytes and observed output usage, and refuses changed billing assumptions.
It does not invent an unsupported server-side output limit. The one-question
input allowance must be at most 32,000 tokens.

### Jev through Vercel AI Gateway

Select this route explicitly; it never replaces the direct TypeSafe route
automatically. `AI_GATEWAY_API_KEY` is used only for the documented
`POST https://ai-gateway.vercel.sh/v1/evaluate` endpoint, using Node's built-in
`fetch`. No new SDK or dependency is required. The same context, instructions,
Choice criteria and decision validation are retained. This route uses camelCase
`usage.inputTokens` / `outputTokens`, not TypeSafe's snake_case usage.

Replace the `jev` section in a **separate private config** with:

```json
{
  "route": "vercel-ai-gateway",
  "model": "typesafe-ai/jev",
  "provider": "digitalocean",
  "requireFree": true,
  "pricing": {
    "inputUsdPerMillion": 0.042,
    "outputUsdPerMillion": 0,
    "fixedUsdPerRequest": 0,
    "source": "https://ai-gateway.vercel.sh/v1/models/typesafe-ai/jev/endpoints",
    "verifiedAt": "2026-09-25"
  }
}
```

This example intentionally **blocks inference**: the public catalog is nonzero
and free-pricing validity is unknown. Keep all approval flags false. Reuse the
existing fixed budget ledger; never initialize a new one for Gateway.
Use `--config <absolute-private-config-path>` with the existing CLI commands.
Without `--live`, `doctor` only checks local prerequisites, including whether the
correct key is present. It neither authenticates the key nor checks live prices.

The caller must select one verified upstream (`digitalocean` or `typesafe-ai`).
The adapter sends `providerOptions.gateway.only` and validates returned routing
identifiers and the final provider. A catalog listing or key does not prove that
an upstream is available to a particular account. There is one client request,
no automatic retries, no model fallback, and redirects are refused. Gateway's
internal attempts are outside client control; when metadata reports more than
one upstream attempt, the result is rejected and retained for reconciliation.

For **free-only** use, all three applicable prices must be verified zero,
approval flags must be true, and `freeUntil` must contain an independently
confirmed ISO timestamp with a time zone covering the entire request deadline.
The adapter checks this both before reservation and immediately before sending.
Do not invent an expiry from a date-only campaign banner or set catalog prices
to zero just to pass the guard. These local checks cannot guarantee a service's
bill. Confirm the key's team, selected upstream, promotion validity and all
additional fees/BYOK settings before authorizing a request. Positive credits and
free-tier eligibility are not proof of zero-priced inference.

As of 2026-09-25, the public page advertised free promotional pricing through
September 25, while the provider catalog reported nonzero input pricing. The
cutoff time was not established. **No live Jev request was made to test the
promotion.** A read-only credits request validated the locally supplied Gateway
key, but did not establish free pricing or evaluation access.

The parser requires complete token usage, finite Choice probabilities, routing
metadata, generation ID and decimal-string `cost`, `surchargeCost` and
`gatewayCost`. Missing fields fail closed rather than becoming zero. Confidence
is optional on this API and is not synthesized. The ledger settles the reported
`gatewayCost`, not a market-price calculation; market pricing stays in the
private raw response. A reported charge during free-only use, an over-bound
debit or an incomplete response blocks subsequent calls pending reconciliation.
This post-response check detects discrepancies; it is **not** prior permission
to make a potentially paid request.

Records carry `route: "vercel-ai-gateway"` and the returned alias
`typesafe-ai/jev`. They do not fabricate `modelVersion: "jev-1.13.0"`: this route
does not establish an immutable upstream model revision. Raw routing metadata
and generation IDs remain private. The public replay identifies the Gateway
route, and decision latency includes the intermediary. No Gateway measurements
have been added to the published GPT-only dataset.

### Jev through OpenRouter

Use `OPENROUTER_API_KEY` from the private environment file and select this
explicit provider section:

```json
{
  "route": "openrouter",
  "model": "typesafe/jev-1.13",
  "pricing": {
    "inputUsdPerMillion": 0.042,
    "outputUsdPerMillion": 0,
    "fixedUsdPerRequest": 0,
    "source": "https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints",
    "verifiedAt": "2026-09-25"
  }
}
```

Recheck applicable pricing before authorizing live calls. Reuse the existing
ledger, explicitly approve access/pricing/publication, and set `maxCalls` to
the current reservation count plus the number of newly authorized calls.
Never initialize a replacement ledger. No credit purchase or auto-top-up is
performed by this adapter; purchase fees are separate from inference costs.

The adapter sends the identical finite-choice task to
`POST https://openrouter.ai/api/v1/systemone` using one bounded built-in fetch.
It never substitutes a TypeSafe/Vercel key, retries, redirects, or falls back to
another route. The catalog checked on the verification date lists one upstream,
TypeSafe. The adapter requires that provider in the response, a generation ID,
snake-case token usage, valid probabilities, and a numeric `usage.cost`.
Missing or over-bound usage/cost fails closed with the maximum reservation held.
It settles the reported debit rather than substituting a list-price estimate.

Development responses were observed with hundredth-rounded probabilities whose
sum was 0.99. For this route only, when every probability is on that grid, the
sum check permits at most half a hundredth per option of rounding error.
Values, keys and the chosen option are still validated; raw probabilities are
preserved without normalization. Other distributions retain the stricter sum
tolerance. This is response-format handling, not confidence-based decision gating.

Responses must name `typesafe/jev-1.13` or the verified dated identifier
`typesafe/jev-1.13-20260917`. Only the latter is recorded as `modelVersion`;
this is a returned provider identifier, not proof of immutable model weights.
Confidence is optional and never invented. Records retain `route: "openrouter"`;
decision latency includes the intermediary. Raw responses and generation IDs
remain private, and no smoke test is automatically published.

Protocol reference: [OpenRouter TypeSafe-compatible API](https://openrouter.ai/docs/guides/community/typesafe-sdk).

## Private configuration

Create the config outside the checkout, normally in the sibling directory:

```text
jev-playwright-repair-lab-private\
  local-config\providers.json
  budget.json
  runs\raw-provider-responses\       # optional
```

All live configurations must use **the same fixed sibling `budget.json` path**,
resolved from this checkout, not a per-provider/per-run ledger. Do not rename,
delete, replace, move, reset, or switch the ledger to regain budget. Keep a durable
private backup. This local guard cannot police manual calls from other clients,
deliberate file edits, disk loss, or separate project copies.

The following is the exact schema with placeholders. Replace angle-bracket
placeholders locally. Price placeholders intentionally make the example
**invalid until replaced by verified JSON numbers**. The Jev value shown is from
the cited official page, not confirmation of your account's applicable terms.
Keep approvals false until the project owner confirms current applicable pricing,
model/API access, and permission to run/publish the experiment.

```json
{
  "schemaVersion": 1,
  "ledgerPath": "C:\\Users\\<YOU>\\claude\\jev-playwright-repair-lab-private\\budget.json",
  "budgetUsd": 10,
  "approvals": {
    "pricingVerified": false,
    "accessConfirmed": false,
    "publicationApproved": false
  },
  "limits": {
    "maxSerializedBytes": 6000,
    "maxInputTokens": 32000,
    "inputTokenOverhead": 2048,
    "maxOutputTokens": 1024,
    "maxResponseBytes": 131072,
    "timeoutMs": 30000,
    "maxCalls": 500
  },
  "azure": {
    "endpoint": "https://<EXISTING-RESOURCE>.openai.azure.com",
    "tenantId": "<EXISTING-TENANT-UUID>",
    "deployment": "gpt-5.5",
    "model": "gpt-5.5",
    "modelVersion": "2026-04-24",
    "pricing": {
      "inputUsdPerMillion": "<VERIFIED-NUMBER>",
      "outputUsdPerMillion": "<VERIFIED-NUMBER>",
      "fixedUsdPerRequest": "<VERIFIED-NUMBER>",
      "source": "<OFFICIAL-PRICE-URL-OR-ACCOUNT-PRICE-REFERENCE>",
      "verifiedAt": "<ISO-8601-DATE>"
    }
  },
  "jev": {
    "model": "jev-1.13.0",
    "pricing": {
      "inputUsdPerMillion": 0.042,
      "outputUsdPerMillion": 0,
      "fixedUsdPerRequest": "<VERIFIED-NUMBER>",
      "source": "https://docs.typesafe.ai/models",
      "verifiedAt": "<ISO-8601-DATE>"
    }
  },
  "rawResponseDirectory": "C:\\Users\\<YOU>\\claude\\jev-playwright-repair-lab-private\\runs\\raw-provider-responses"
}
```

Either live-provider section may be omitted. `rawResponseDirectory` is optional;
omit it to disable raw response files. The Azure endpoint, tenant, local paths,
raw responses, and request IDs must remain private unless separately reviewed.
Raw files include the response and reservation ID only, not request headers or
credentials. Paths and existing ancestors are resolved to reject symlink/junction
routes back into the public repository.

Provide the Jev key only through the local process environment
(`TYPESAFE_API_KEY` for direct access, `AI_GATEWAY_API_KEY` for Gateway,
`OPENROUTER_API_KEY` for OpenRouter).
The CLI also loads the private `local-config/providers.env` file.
Never place a key in JSON, command history, a chat message, a
test fixture, the public demo, Git, or an Actions secret for live PR execution.
The SDK's environment base-URL/model/logging overrides are not used: the adapter
explicitly fixes these settings and disables SDK logs.

## Budget protocol and recovery

1. After verifying this is a new project ledger, initialize it **once**, explicitly:
   `await new BudgetLedger(config.ledgerPath, config.budgetUsd).initialize()`.
   Initialization is exclusive and refuses to overwrite an existing file.
   A missing previously used ledger requires recovery from its durable backup,
   not a new zero balance.
2. Validate the config, approvals, input, and credential presence. Limit the full
   JSON payload including instruction, question/schema, all candidates, and
   serialization overhead. A deliberately pessimistic four tokens per UTF-8 byte
   plus configured framing allowance must fit the input-token allowance.
3. Hold an exclusive filesystem lock while reading and atomically updating the
   ledger. Reserve the **full configured input allowance**, maximum output
   allowance, and any fixed request charge at verified rates. Amounts are rounded
   upward to integer nanodollars. The cap is at most USD 10 across **both providers,
   development, smoke calls, evaluation, and explicit retries**.
4. Persist and flush the reservation before acquiring Azure tokens or sending a
   model request. One unresolved reservation blocks other processes/providers
   unless the bounded retained-maximum exception below was explicitly authorized;
   a process-wide guard also enforces concurrency one.
5. Both direct-provider SDKs set retries to zero on the client and request.
   Gateway and OpenRouter use one built-in fetch call without a retry loop. The transport also
   rejects a second attempt, unexpected URL/method, and HTTP redirects. It bounds
   response bytes. A total deadline aborts the call and includes credential wait.
6. Settle only complete validated responses with valid usage within the reserved
   bounds. The estimate includes reasoning at the output rate and assumes no cache
   discount. A successful `NO_REPAIR` or `ABSTAIN` is still a billed decision.
7. **Every post-reservation failure** (including timeout, authentication, refusal,
   malformed choice, unknown usage, or raw-record write failure) retains its
   maximum reservation and blocks further calls by default. Crashes leave `reserved`
   entries, which also block. No automatic release is possible.
8. Recover only after confirming final provider billing **and that the request
   has terminated**, then explicitly call
   `await ledger.reconcile(reservationId, verifiedActualUsd, privateEvidence)`.
   Reconciliation is a human-audited operation, not a retry/recovery heuristic.
   A verified charge above the cap is preserved and permanently prevents further
   reservations. Never reconcile to zero merely because an HTTP request failed.
   If there is exactly one unknown reservation from a verified terminal
   authentication/permission rejection, a user can instead explicitly authorize
   `ledger.authorizeOneAdditionalCall(id, terminalEvidence)`. Evidence must
   identify the terminal rejection and permission to proceed with its full maximum
   still charged against the budget. This records a one-reservation allowance:
   the original entry remains **unknown**, with no invented `actualNanos` or
   zero-cost settlement. The allowance is consumed atomically by the next
   reservation, even if that new request fails. It never applies to timeouts,
   active requests, cost overruns, or other failures. `doctor` reports unresolved
   entries, retained maximum USD, and available authorizations separately.
   After that one call, the unresolved entry blocks further reservations again.
   A separately authorized experiment can use
   `authorizeAdditionalCalls(id, count, terminalEvidence)` with an explicit
   positive integer count. This does not create an unlimited exception: every
   reservation consumes one allowance, the existing call and dollar caps still
   apply, and any new unknown request immediately blocks the remainder.
9. Locks are never auto-expired or stolen. For a crash lock, first verify the
   recorded process and any in-flight request are no longer running; preserve the
   ledger/evidence, remove only that confirmed stale lock, and reconcile any
   unresolved reservation. If unsure, stop.

Changing an existing cap is rejected. Calls, including failed calls, count toward
the durable `maxCalls` limit. The serialized-byte/token allowances are conservative
engineering bounds, not a universal tokenizer proof; if observed usage violates
them, stop and reconcile. Current pricing, service-side enforcement, other
clients, and the final invoice are outside this code's control: the ledger is a
fail-closed estimate guard, **not a guarantee of the provider's final bill**.

## Validation and first-party references

`npm test -- packages/providers/src/providers.test.ts` tests the real pinned SDKs
with **mocked HTTP transport and mocked Azure credentials**, no model calls.
Scratch directories are unique children of the provider source folder and are
removed after each test (not OS temporary directories). Tests cover persistence,
exclusive reservations, cap/call limits, unknown billing, malformed choices,
refusal, input limits, low-confidence Jev decisions, usage/reasoning accounting,
timeouts, retries, and global concurrency.

Verified against these first-party documents and installed SDK declarations:

- [Azure v1 endpoint and Entra scope](https://learn.microsoft.com/azure/foundry/openai/api-version-lifecycle)
- [Azure endpoint switching and deployment names](https://learn.microsoft.com/azure/foundry-classic/openai/how-to/switching-endpoints)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe SDK v0.6.0 request/retry/result types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)
- [TypeSafe Choice HTTP API and usage](https://docs.typesafe.ai/api)
- [Jev pinned model, input-only billing, and context limits](https://docs.typesafe.ai/models)
- [Vercel evaluation HTTP API and Choice response](https://vercel.com/docs/ai-gateway/modalities/evaluation#http-api)
- [Vercel provider routing controls](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)
- [Vercel generation-cost definitions and read-only credits API](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)
- [Vercel Jev promotion announcement](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)
- [Gateway pricing and additional charges](https://vercel.com/docs/ai-gateway/pricing)

SDK versions, the actual returned model string, source/data/config fingerprints,
and local verification dates should be recorded by the experiment runner. Do not
publish these tests' mocked responses or rates as measured experiment results.
