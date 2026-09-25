# GPT-5.5-only evaluation: 2026-09-25

> Historical report for the first, GPT-only collection. Its measurements and
> accounting below describe that point in time. The later
> [three-way comparison](comparison-results.md) preserves all 108 GPT records
> and adds separately collected Jev/rule runs with explicit provenance.

This is an engineering experiment report, not a completed Jev comparison.
Jev has not been called. The public dataset contains the entire final run,
including abstentions, rejections, and deterministic guards, not selected wins.

## Frozen conditions

- Source: [`821a056ac8459a4ee4e3daa35cc9665bb9ebba42`](https://github.com/yukurash/jev-playwright-repair-lab/tree/821a056ac8459a4ee4e3daa35cc9665bb9ebba42).
  Publication-only data, documentation, and viewer changes follow that commit;
  the engine, prompts, candidate generator, and provider adapter are unchanged.
- Azure OpenAI `gpt-5.5`, version `2026-04-24`, Global Standard.
  Successful responses reported `gpt-5.5-2026-04-24`.
- Final split: 18 families, 36 variants, three repetitions, seed 42.
  Cases are shuffled once; each variant's three repetitions are consecutive.
  Only Azure was scheduled, so there is no cross-provider interleaving yet.
- One development pilot and one complete 12-trial development run preceded the
  final run. No prompt, code, or provider-setting tuning occurred after these
  runs; the calibration split was not used.
- Strict finite-choice JSON, no tools, no streaming, `store: false`,
  `max_completion_tokens: 8192` including reasoning, 120-second deadline.
  No explicit reasoning effort, temperature, or provider seed was sent; provider
  defaults apply. The scheduling seed does not make model sampling deterministic.
- Input guard: 6,000 serialized UTF-8 bytes, 32,000 conservative token allowance,
  2,048 framing allowance. Responses capped at 131,072 bytes.
  Serial execution, zero SDK retries, shared USD 10 project ledger.
- Model calls receive authored task context, not evaluation oracles or case IDs.
  A browser success is accepted only if the independent target/state checks pass.

## Complete final-run results

| Measure | Recorded result |
| --- | --- |
| Scheduled / recorded / missing trials | 108 / 108 / 0 |
| API decisions / deterministic guard trials | 90 / 18 |
| API or execution errors | 0 |
| Correct repairs / repairable trials | 48 / 48 |
| Repairable families / distinct variants | 8 / 16 |
| Correct `NO_REPAIR` / missing-target trials | 18 / 18 |
| `ABSTAIN` / indistinguishable-target trials | 5 / 6 |
| Nonunique selection blocked by code | 1 |
| Wrong-target green | 0 |
| Right-target regression green | 9 |
| Decision wall time p50 / p95 (90 decisions) | 3,808.733 / 6,067.983 ms |
| End-to-end time p50 / p95 (same 90 trials) | 5,619.731 / 8,223.395 ms |
| Final-run estimated API cost | USD 0.284355 |

The 48/48 figure is **not** 108/108 success or a general reliability claim.
Nonrepairable, missing, indistinguishable, regression, and guard cases have
different expected behavior and are not included in that repair-success denominator.
Repetitions and variants are correlated, not 48 independent tasks.
Percentiles use nearest rank. Decision time includes the adapter's credential
acquisition, budget I/O, and network wait; it is not server-only inference time.

| Category | Families | Trials | API calls | Outcome |
| --- | ---: | ---: | ---: | --- |
| Rename | 3 | 18 | 18 | 18 correct repairs |
| Container change | 3 | 18 | 18 | 18 correct repairs |
| Ambiguous controls | 3 | 18 | 18 | 12 correct repairs, 5 abstentions, 1 nonunique selection blocked |
| Missing target | 3 | 18 | 18 | 18 correct `NO_REPAIR` |
| Locator plus business regression | 3 | 18 | 18 | 18 rejected; 9 passed weak original assertions but failed the independent oracle |
| Unsupported input guards | 3 | 18 | 0 | Stopped by code, not model judgment |

Two observations are especially important:

1. In one `indistinguishable-approval-b` repetition, the expected decision was
   `ABSTAIN`, but GPT-5.5 selected `c1`. The engine rejected the nonunique locator
   before patching or clicking. This is a model decision error caught by code,
   not evidence that the model always abstains safely.
2. The `email-not-sent-a`, `inventory-underflow-a`, and `invite-wrong-tenant-a`
   variants each passed the original weak assertions in all three repetitions.
   GPT-5.5 selected the correct targets, but the independent business-state oracle
   failed. All nine were rejected, not counted as repaired. This is insufficient
   assertion coverage, not a wrong-target selection.

## Cost and accounting

Official [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/)
and the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
were checked on 2026-09-25 JST for Global Standard short-context consumption:
USD 5 per million input tokens, USD 30 per million output tokens, no fixed request
charge. The applicable input/output meters were `5.5 ShortCo inp Gl 1M Tokens`
and `5.5 ShortCo opt Gl 1M Tokens`. Reasoning is included in output tokens;
cached input is conservatively costed at the full input rate.

| Stage | Trials | API calls | Estimated USD |
| --- | ---: | ---: | ---: |
| Development pilot | 1 | 1 | 0.002515 |
| Complete development split | 12 | 10 | 0.025275 |
| Final split | 108 | 90 | 0.284355 |
| Project total so far | 121 | 101 | 0.312145 |

The nanodollar ledger rounds each settled amount upward: its total is
USD 0.312145007, leaving USD 9.687854993 of the shared USD 10 cap.
There are no unresolved reservations, automatic retries, Jev calls, purchases,
or top-ups. Rates times observed usage are estimates, not an Azure invoice.
Private pricing evidence, raw responses, manifests, and a ledger backup are retained.

The final run's 18 guard records have no model usage or recorded cost. The generic
summary therefore reports 18 missing cost fields; these are known no-call guards,
not 18 API calls with unknown billing. All 90 final API decisions have usage and
cost observations. The development run similarly has two no-call assertion guards.
Do not replace arbitrary missing cost fields with zero.

## Inspect and reproduce

- [Recorded demo](https://yukurash.github.io/jev-playwright-repair-lab/)
- [All 108 allowlisted trial records](../data/public/results.json)
- [Protocol and limitations](methodology.md)
- [Private setup and budget protocol](providers.md)

In a clean checkout of the frozen source, with your own approved Azure access,
verified prices, and the existing shared ledger:

```powershell
npm run freeze -- --split final --provider azure --repetitions 3 --seed 42
npm run evaluate -- --manifest <returned-private-manifest-path> --live
npm run summarize -- --run <returned-run-id>
```

These commands incur new charges and are **not** needed to view published results.
Never reset the existing budget to repeat a run. The same model version and
conditions do not guarantee identical responses or timings.

Before a later Jev comparison, preserve the same engine, candidate inputs, and
split. If they must change, version the experiment and disclose/rerun the affected
baseline rather than silently comparing incompatible runs. This initial run alone
cannot establish speed, cost, or quality superiority over Jev or the rule baseline.
