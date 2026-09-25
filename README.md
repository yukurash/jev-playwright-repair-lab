# Jev Playwright Repair Lab

Build a locator-only Playwright repair tool and compare deterministic rules,
Azure OpenAI GPT-5.5, and Jev on the same finite choices.

The first **GPT-5.5-only** evaluation is recorded: 108 final trials, including
90 API decisions and 18 deterministic guards. Jev has not been measured, and
this release is not a model-to-model comparison. See the
[measured results and limitations](docs/gpt-5.5-results.md).
A passing test alone does not count as a successful repair:
an independent target and application-state check must also pass.

The public demo will replay recorded, sanitized results without API keys.
Live model calls run only in the local CLI. Credentials, raw runs, and the
Zenn article are kept outside this repository and all deployment artifacts.

## Guardrails

- Only self-authored fixtures; this is not an arbitrary-repository repair agent.
- Change a supported static locator, never assertions, actions, or input values.
- Never hide ambiguity with `.first()`, forced actions, skips, or longer timeouts.
- Do not attribute deterministic safety guards to model intelligence.
- API spending requires configured credentials, verified pricing, and a shared
  budget ledger capped at USD 10. No automatic purchasing or top-ups.

## Setup

Use Node.js 24 and npm:

```powershell
npm ci
npx playwright install chromium
npm run verify
npm run test:browser
npm run doctor
```

`verify` performs the type check, unit tests, static demo build, and publication
boundary scan. Browser regression tests use a real, pinned Chromium. Tests and
builds never require model credentials and must not incur API charges.

The initial supported scope is this repository's authored fixtures, not arbitrary
TypeScript projects. See [repair engine](docs/repair-engine.md) for exact supported
forms and [experiment protocol](docs/methodology.md) for comparisons and limits.

## Working directories

Keep the public checkout and private outputs as siblings:

```text
jev-playwright-repair-lab/          public source checkout
jev-playwright-repair-lab-private/  NOT a Git repository
  local-config/                   keys and provider configuration
  runs/                           frozen manifests and raw results
  workspaces/                     disposable test execution copies
  article/                        private Zenn manuscript and preview
  assets/                         private article images
```

The CLI defaults to the private sibling. `--private-dir` selects another directory
outside the public checkout; output inside the checkout is rejected. Do not copy
private files into PRs, Actions artifacts, or the demo's public/static directory.

## API setup

Get your own Jev access and personally review the applicable terms at
[TypeSafe](https://console.typesafe.ai/keys). Put `TYPESAFE_API_KEY` in your shell
environment or the private `local-config/providers.env` file, never in chat or Git.
There is no automatic credit purchase or auto-top-up.

Alternatively, select the explicit **Vercel AI Gateway** route and supply
`AI_GATEWAY_API_KEY` in that same private environment file. Do not put a Gateway
key in `TYPESAFE_API_KEY`. The route uses `typesafe-ai/jev`, not a verified pinned
upstream revision. See [Gateway setup and free-only checks](docs/providers.md#jev-through-vercel-ai-gateway).
Gateway support is mock-tested; Jev remains unmeasured. API-key validity and a
promotional banner do not establish that an inference request is free.

Use an existing Azure OpenAI GPT-5.5 deployment with Azure CLI / Entra ID
authentication. This repository does not provision Azure infrastructure or
silently switch models. See [provider configuration](docs/providers.md) for
connection and verified-pricing fields.

`doctor` is read-only and free by default. Model requests require explicit
`--live`, complete configuration, verified applicable prices, and the persistent
shared budget ledger. A timeout with unknown usage retains its reservation and
stops subsequent paid work rather than assuming it was free.

After completing private configuration, initialize the genuinely new project
ledger once. This command does not make API calls and refuses an existing ledger:

```powershell
npm run budget:init -- --confirm-new-budget
```

Never delete an existing ledger to reset the budget. Recovery and explicit
reconciliation are documented in [provider configuration](docs/providers.md).

## Local workflow

```powershell
# List the authored cases and readiness without calling either model.
npm run doctor

# Use an actual case ID reported by doctor.
npm run capture -- --case <case-id>
npm run repair -- --case <case-id> --provider rule

# Only after access, pricing, and permission have been confirmed:
npm run doctor -- --provider jev --live
npm run doctor -- --provider azure --live
npm run repair -- --case <case-id> --provider azure --live
npm run repair -- --case <case-id> --provider jev --live

# Freeze on a clean, committed checkout; final runs reject source changes.
npm run freeze -- --split final
npm run evaluate -- --manifest <private-manifest-path> --live
npm run summarize -- --run <run-id>

# Review service terms and public data before explicitly permitting export.
npm run export:public -- --run <run-id> --confirm-publication
npm run verify
npm run preview:demo
```

Original tests are not overwritten. Temporary execution copies live in the private
directory and are cleaned up; durable result records retain the original and
patched test for inspection. An error is reported explicitly; it never turns into a fake
successful repair or an unannounced fallback to another provider.

## Public demo and development

[GitHub Pages](https://yukurash.github.io/jev-playwright-repair-lab/) is a keyless
**recorded replay**, not a hosted inference endpoint. It currently shows all
108 final GPT-5.5-strategy trials and explicitly labels Jev as unmeasured.
An empty dataset instead shows a clearly marked conceptual walkthrough.
Do not mistake animation time for actual inference latency.

Changes go through a branch and PR. Required CI runs on Windows and Ubuntu, with
separate browser regressions. A successful main-branch CI triggers artifact-based
Pages deployment of that exact source SHA; no generated-source bot commits are
needed. Commits retain the maintainer as primary author and credit Copilot as
co-author. This project does not backdate or pad contribution history.

## License

MIT. See [LICENSE](LICENSE).

The unmodified Anthropic `frontend-design` skill under
[.github/skills/frontend-design](.github/skills/frontend-design) is separately
licensed under its included Apache-2.0 [LICENSE.txt](.github/skills/frontend-design/LICENSE.txt).
See the [demo design notes](apps/demo/README.md#design) for provenance and scope.
