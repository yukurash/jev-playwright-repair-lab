# Experiment protocol

## Status

The [three-way comparison](comparison-results.md) was completed on 2026-09-25
JST: 324 scheduled/recorded final trials, 108 per strategy. GPT and Jev each
made 90 API decisions; all three strategies had 18 code-guard trials. The
[original GPT-only run](gpt-5.5-results.md) is preserved unchanged. These were
separate schedules, not cross-provider interleaving. The explanatory empty-state
demo remains distinct from recorded results.

## What is being compared

Three interchangeable finite-choice strategies receive the same operation intent,
old locator, old context, and current candidates: deterministic rules, Azure
GPT-5.5, and Jev. Providers select an opaque candidate ID, `NO_REPAIR`, or `ABSTAIN`.
They do not generate a patch or a new assertion. There is no extra LLM call to
extract intent. Case IDs and evaluation oracles are not part of model context.

The candidate generator, AST patcher, Playwright executor, and independent oracle
are shared. Their guards are **code capabilities**, not evidence of model skill.
A passing unmodified test and assertion-only failures do not require model repair.
Primary comparisons do not gate Jev on confidence while leaving GPT unprotected.
Jev confidence is not a measured probability that a repair is correct.

## Corpus and freezing

The authored corpus has 30 scenario families with two variants each, across
rename, container change, ambiguity, missing target, simultaneous locator/business
regression, and guards/unsupported cases. Family-level split: six development,
six calibration, eighteen final. Rephrasings and repetitions are correlated, not
independent samples. These synthetic families still share renderer and workflow
patterns; they are not a representative sample of production applications.

Before final evaluation, freeze the tested Git SHA, lockfile hash, instruction
hash, case IDs, seed, repetitions, and provider configuration. Run the same cases
in a seeded order; interleave providers when collecting a joint run. The completed
comparison instead used separate schedules, which must be disclosed rather than
described as interleaved. Final evaluation refuses dirty trees,
different SHAs, changed inputs, or cases from another split. Do not tune on final
cases and subsequently call them unseen.

The completed final schedule is 36 variants, three repetitions per strategy:
324 trials and 180 model calls after code guards. Report
scheduled trials, actual decisions, missing trials, and errors separately.
Confirm pilot usage and applicable prices before claiming that the USD 10 budget
can cover this schedule. Failed and uncertain calls consume reservations.

## Success and misleading green

A correct repair requires a repairable case, a permitted locator-only patch,
the correct semantic target, the original assertions, and the independent
application-state oracle. Report at least:

- Correct repairs / repairable trials, plus the number of distinct families.
- Wrong-target green: original assertions pass, but the wrong target was used.
- Right-target regression green: correct target and passing original assertions,
  but the independent state check exposes a business bug missed by weak assertions.
- Correct `NO_REPAIR`, abstentions, unnecessary repairs, candidate omissions,
  unsupported inputs, model/protocol errors, and missing records.

The two green-but-wrong outcomes have different causes. The second is not proof
that the selector picked incorrectly. A lack of observed errors in this small
synthetic corpus does not establish general safety or universal superiority.

## Time, cost, and aggregation

Record capture, decision, validation, and total wall-clock time separately.
Decision p50/p95 use nearest-rank quantiles over trials with a returned decision;
guard-only cases are not counted as zero-millisecond model calls. Raw measurements
are retained privately, including failures.

Sum observed cost only where usage/pricing is available and show observation and
missing counts. Missing is not zero. Record reasoning tokens within billable
output, cached input where reported, development/calibration calls, and retries.
No inference about provider invoice totals should be made from an incomplete run.
The budget guard is conservative accounting, not a guarantee against every
possible provider billing discrepancy.

For the optional Vercel route, record `route: "vercel-ai-gateway"` and retain raw
routing/charge metadata privately. Gateway latency includes an intermediary;
the `typesafe-ai/jev` alias does not independently prove a pinned upstream
revision. Report the actual Gateway debit separately from its market price,
and disclose promotional pricing rather than presenting free promotional calls
as a permanent cost advantage. The Gateway adapter is mock-tested; no Gateway
measurements are included in the public dataset. The original GPT run remains
unchanged. The completed OpenRouter comparison discloses separate schedules/source
SHAs and verifies unchanged fixtures and
instructions; do not present it as an interleaved, single-source experiment.

For OpenRouter, record `route: "openrouter"`, returned model ID, and numeric
`usage.cost`. Record a dated version only when the response actually contains it.
Latency includes OpenRouter; credit purchase fees are not per-request inference
costs. Connectivity and development trials are excluded from final metrics but
included in cost accounting. Unknown charges held at their maximum remain
unknown, even if a user explicitly authorizes a bounded later experiment with
that maximum retained.

The first Jev development run stopped at a response whose hundredth-rounded
probabilities summed to 0.99. Its record and verified charge were retained.
Only the OpenRouter format parser was corrected before refreezing the completed
development/final runs; no prompts or task logic were tuned. See the
[comparison report](comparison-results.md) for full provenance and accounting.

## Runtime

Playwright is pinned to 1.61.1 with Chromium 149.0.7827.55 (revision 1228).
The initially selected 1.63.0 browser download repeatedly timed out in this
environment; we explicitly selected a pinned, available matching browser rather
than silently substituting a system Chrome executable. The lockfile and CI use
the same Playwright version.

## Publication boundary

The GitHub Pages application is a replay of allowlisted, recorded results. It
does not run inference or Playwright. Animation speed is not inference latency.
Raw requests/responses, actual Azure endpoints, keys, article manuscripts, and
article assets remain in a separate non-Git directory. Check both tracked/new
source files and the built Pages artifact before deployment.

Real API results may be exported only after confirming the applicable service
terms and publication scope. The user must personally register and accept terms;
this project never buys credits or enables automatic top-ups.
