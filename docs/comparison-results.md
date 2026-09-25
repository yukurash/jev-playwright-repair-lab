# Rules, GPT-5.5 and Jev: recorded locator-repair comparison

Measured on 2026-09-25 JST. This is a constrained, authored-fixture experiment,
not an arbitrary-repository repair benchmark or a universal model ranking.
The public replay contains all **324 final trials**, including abstentions,
rejections and code guards. Development and connectivity checks are not mixed
into final accuracy or latency.

## Conditions and provenance

Each strategy evaluated the same 18 final families / 36 variants, three times
per variant, with schedule seed 42: 108 trials each. Every strategy made 90
decisions; 18 trials per strategy were stopped by deterministic code guards.
Only GPT and Jev decisions incurred model calls. Repetitions were consecutive
per variant and are correlated, not independent benchmark samples.

| Strategy | Served model | Tested source | Execution window (JST, recorded trial timestamps) |
| --- | --- | --- | --- |
| Lexical rules | `deterministic-lexical-v1` | [`ca01954`](https://github.com/yukurash/jev-playwright-repair-lab/tree/ca01954b0e43e624a063cdca127300b56b21efa0) | 16:12:40–16:15:26 |
| Azure OpenAI GPT-5.5 | `gpt-5.5-2026-04-24` | [`821a056`](https://github.com/yukurash/jev-playwright-repair-lab/tree/821a056ac8459a4ee4e3daa35cc9665bb9ebba42) | 08:40:53–08:50:09 |
| Jev via OpenRouter / TypeSafe | `typesafe/jev-1.13-20260917` | [`ca01954`](https://github.com/yukurash/jev-playwright-repair-lab/tree/ca01954b0e43e624a063cdca127300b56b21efa0) | 16:08:53–16:12:23 |

These were **separate schedules, not a randomized interleaved experiment**.
GPT results were preserved unchanged; no new GPT requests were made for this
comparison. Azure used Global Standard in South India with Entra authentication;
Jev used OpenRouter's System One endpoint. Decision timings include those
different routes and client bookkeeping, not server-only inference.

Before the new runs, Git comparison confirmed unchanged fixtures, renderer,
oracles, browser executor, patcher, deterministic rules and lockfile. Compiled
core task code was identical; the engine change only copies route metadata.
The final audit also compared every case's before/after snapshots, original
test, candidate set, expected decision and repairability across all three runs.
They matched, and the original 108 public GPT records were unchanged.

- Shared instruction SHA-256:
  `322c9ff7fde2248ccc9368d782c3752a17b2dd4c653efe76fa3bf427d1326d36`
- Shared lockfile SHA-256:
  `da6f701f6edd00e9b10391ae7f82509318fcf006bd49408463c69cb674891b00`
- Input: same finite choices, intent, old locator/context and current candidates;
  no oracle, correct-target label or case ID in the model input.
- No model-generated patches or explanations; no confidence-based gating.
- No model retries. Same 120-second deadline and conservative 32,000-token
  input allowance; 6,000 serialized-byte and 131,072 response-byte caps.
- Azure: strict JSON output, 8,192 maximum output tokens including reasoning,
  no explicit reasoning effort/temperature. Jev: typed Choice output with
  input-only pricing; 8,192 observed output-token accounting bound, not a
  claimed Jev server-side output limit.

## Final results

| Measure | Lexical rules | GPT-5.5 | Jev |
| --- | ---: | ---: | ---: |
| Scheduled / recorded trials | 108 / 108 | 108 / 108 | 108 / 108 |
| Missing trials / execution errors | 0 / 0 | 0 / 0 | 0 / 0 |
| Correct repairs / repairable trials | 30 / 48 | 48 / 48 | 48 / 48 |
| Correct `NO_REPAIR` / missing-target trials | 0 / 18 | 18 / 18 | 18 / 18 |
| Correct `ABSTAIN` / indistinguishable trials | 0 / 6 | 5 / 6 | 6 / 6 |
| Wrong-target green | 30 | 0 | 0 |
| Right-target regression green | 6 | 9 | 9 |
| Accepted repairs on nonrepairable cases | 0 | 0 | 0 |
| Deterministic guard trials | 18 | 18 | 18 |
| Final model API calls | 0 | 90 | 90 |

Correct repair means a permitted locator-only patch, correct target, original
assertions and independent state oracle all pass. The 48 repairable trials cover
eight families / sixteen variants, each repeated three times. **48/48 does not
mean 108/108 successful repairs**, nor establish production reliability.

The rules are a deliberately small lexical baseline (exact matches and token
overlap), not the best possible rule engine. Its weaker result does not show
that all deterministic approaches fail. Its deterministic repetitions do not
add independent evidence.

### Concrete failure modes

- `article-publish-a`: the intended action is publishing. GPT and Jev selected
  **Make article public**. Rules selected **Save draft**; the original assertion
  only checked **Article updated**, so it passed despite the wrong action.
  Independent target/state checks rejected this misleading green.
- `backup-create-a`: the intended **Back up now** became **Create recovery copy**.
  GPT and Jev repaired it. The lexical baseline abstained rather than resolving
  the semantic rename.
- `indistinguishable-approval-*`: Jev abstained in all six repetitions; GPT in
  five. GPT's one nonunique candidate selection, and the rules' six selections,
  were blocked by code before an unsafe patch/action. Six correlated trials
  are not enough to conclude a general safety advantage.
- `email-not-sent-a`, `inventory-underflow-a`, `invite-wrong-tenant-a`: both models
  selected the correct target and passed the weak original assertions, yet the
  independent business oracle failed in all nine repetitions. These are not
  target-selection mistakes. Rules only reached six such green outcomes, partly
  because they abstained elsewhere; the lower count is not better bug detection.

No misleading green was accepted as a successful repair. This protection comes
from the shared code/oracle, not a model guarantee.

## Time and cost

Nearest-rank percentiles over the same 90 decision-bearing trials per strategy;
guards are excluded rather than inserted as zero-time model answers.

| Measure | Lexical rules | GPT-5.5 | Jev |
| --- | ---: | ---: | ---: |
| Decision p50 (ms) | 0.1644 | 3,808.7330 | 275.1856 |
| Decision p95 (ms) | 0.3545 | 6,067.9828 | 423.3024 |
| End-to-end p50 (ms) | 1,563.5914 | 5,619.7308 | 1,925.4546 |
| End-to-end p95 (ms) | 1,800.6570 | 8,223.3947 | 2,709.5804 |
| Final inference USD | 0 | 0.284355 | 0.00191709 |
| Input / output tokens reported | N/A | 22,533 / 5,723 | 45,645 / 4,980 |

The observed GPT/Jev decision-median ratio is **13.84**, but the end-to-end
median ratio is **2.92**: browser work remains. The final-run cost ratio is
**148.33**. These are descriptive ratios for these schedules/routes/prices, not
controlled model-speed claims. Medians are not additive stage measurements.
Identical text does not imply identical tokenization or service framing.

GPT cost is an estimate from returned usage at verified Azure prices
($5/M input, $30/M output, conservatively no cached-input discount), not its
final invoice. Jev cost is reported `usage.cost` at OpenRouter's verified
$0.042/M input and zero output price. Credit purchase fees, taxes, infrastructure
and engineering time are excluded; no model access is claimed free.

The 18 guard trials in each run have no model usage/cost field. They are known
no-call guards, not unknown paid usage to fill with zero.

## Preparation, failure and budget transparency

Jev used 102 OpenRouter calls in total:

| Stage | Calls | Reported USD |
| --- | ---: | ---: |
| Connectivity pilot | 1 | 0.000020538 |
| Aborted development run | 1 | 0.000021378 |
| Completed development split | 10 | 0.000214494 |
| Final split | 90 | 0.001917090 |
| Total | 102 | 0.002173500 |

The first development response chose the correct candidate but its
hundredth-rounded probabilities summed to 0.99. Our overly strict sum check
rejected it and stopped the run. The original failed record was retained.
Authenticated generation metadata confirmed its terminal response and
$0.000021378 charge before explicit reconciliation.

Before the completed development/final runs, we fixed only the OpenRouter
response parser: hundredth-grid distributions may differ from one by at most
half a hundredth per option; keys/ranges/choice still must validate. Raw values
are not normalized, and no confidence threshold selects or overrides a choice.
Tests and a new source/config freeze preceded the manual development restart.
No prompt/task tuning occurred, calibration was unused, and no final cases
were rerun or dropped. This initial parser error is not hidden as a Jev
classification error or a free request.

Authenticated OpenRouter key usage after all runs was **$0.0021735**, matching
the total. Including the historical 101 Azure calls and two rejected Vercel
attempts, the project ledger contains 205 reservations:

- Known settled usage estimates/debits: **$0.314318507**.
- One old, terminal Vercel rejection remains billing-unknown, retaining its
  complete **$0.001344** maximum. It was not silently settled to zero.
- Conservative committed total: **$0.315662507** of the shared $10 cap.
- No new Azure/Vercel requests, automatic retries, purchases or top-ups were
  performed during this comparison.

An explicitly user-authorized finite allowance let the new experiment retain
that old maximum while proceeding. The allowance is now exhausted; additional
model calls require a fresh authorization. The ledger is a conservative guard,
not a promise about external invoices.

## Reproduce or inspect

- [Recorded comparison](https://yukurash.github.io/jev-playwright-repair-lab/)
- [All final records](../data/public/results.json)
- [Protocol](methodology.md) and [provider setup](providers.md)
- [Historical GPT-only report](gpt-5.5-results.md)

To reproduce the Jev run, check out its tested source, configure your own
approved OpenRouter access outside the checkout, and retain the shared ledger:

```powershell
npm run freeze -- --split final --provider jev --repetitions 3 --seed 42 --config <private-config>
npm run evaluate -- --manifest <returned-private-manifest> --live --config <private-config>
```

For rules, use `--provider rule` when freezing and omit `--live` when evaluating.
Fresh API runs cost money and may differ; the recorded demo needs no keys.
The Zenn manuscript and article assets remain private and are not repository
or deployment contents.

### Explicit comparison export

The original `export-public` remains single-run and rejects mixed source SHAs.
The publication code adds a separate, explicit path:

```powershell
npx tsx packages\cli\src\index.ts export-comparison --run <gpt-final-run> --compare-with <jev-final-run> --compare-with <rule-final-run> --config <private-config> --confirm-publication
```

This validates completed final manifests, seeded schedules, full case/repetition
coverage, matching shared hashes and actual task inputs before projecting an
allowlist. Public provenance retains each run's source and time window rather
than inventing a single tested source for all records. A reproduction on the
frozen inference commit can collect runs; use the later publication code for
this multi-run export.
