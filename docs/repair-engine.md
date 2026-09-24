# Locator-only repair engine

This is a deliberately limited experiment on an original, synthetic fixture app,
not a general-purpose test-repair agent. It uses real headless Playwright Chromium,
real locator actionability/strictness, and Playwright's retrying assertions. No API
credentials are needed for fixture or rule-provider runs.

## Public API

`packages/engine/src/index.ts` exports:

```ts
const cases: readonly CaseMetadata[];
const datasetManifest: {
  schemaVersion: 1;
  independenceUnit: "familyId";
  variantsPerFamily: number;
  cases: readonly CaseMetadata[];
  // authorship and variantPolicy descriptions are also included
};

function capture(caseId: string): Promise<CaptureResult>;
function runCase(
  caseId: string,
  provider: DecisionProvider,
  options?: { sourceSha?: string; workspaceRoot?: string },
): Promise<TrialResult>;
```

`CaseMetadata` has `id`, `familyId`, `split`, `category`, and `title`.
`CaptureResult` has:

- `caseId`, `originalTest`, `beforeHtml`, `afterHtml`, `candidates`;
- `baselinePassed: boolean`, `originalTestPassed: boolean | null`;
- `request: DecisionRequest | null`;
- `status: "repairable" | "unchanged" | "unsupported" | "assertion-only" | "baseline-failed"`;
- optional `reason`.

Capture's `repairable` status means **eligible for a locator decision**, not that
a correct repair exists. Missing targets and simultaneous business regressions
are intentionally eligible. `TrialResult.repairable` instead reflects independent
evaluation truth: a supported unambiguous target with a correct business outcome.
Guarded cases return no request and never invoke a provider. Capture infrastructure
errors reject; `runCase` records infrastructure/provider errors as `status: "error"`.
Unknown case IDs reject in both APIs.

## What is actually executed

Each authored case stores a Playwright test body:

```ts
test("Place order", async ({ page }) => {
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Place order", exact: true }).click();
  await expect(page.getByTestId("status")).toHaveText("Order received");
});
```

The narrow in-process harness supplies `test`, `expect`, `page`, and `baseURL`.
It registers exactly one test, reads its unchanged source from an owned workspace,
and executes that body against the before and after apps. It uses actual
`@playwright/test` browser and assertion APIs; it does **not** emulate actions,
fabricate assertion results, invoke the full Playwright Test CLI, or support that
runner's hooks/configuration/import ecosystem. The same original source is
executed on both app revisions. Only an eligible decision produces a third run
with the verified locator range replaced. Assertions and action arguments remain
byte-for-byte unchanged.

The actual thrown stack's source line **and column** must lie inside the action's
AST statement (an assertion on the same line is still not an action failure).
An assertion failure, unverified failure location, unsupported syntax, failing
baseline, still-unique original locator with an actionability failure, or passing
original test cannot trigger model inference. Guard-only trials are recorded as
deterministic with model `not-called`, even when the requested provider is a model.
Fixture-only
action/assertion timeouts are 650 ms; navigation timeout is 5 seconds. These
constants are harness policy, never provider-controlled or repaired test edits.

## Supported static syntax

- Exactly one standalone `await locator.click()` or `await locator.fill("value")`.
- `page.getByRole("button" | "textbox", { name: "literal", exact: true })`.
- `page.getByLabel("literal", { exact: true })`.
- Either locator can follow one
  `page.getByRole("group", { name: "literal", exact: true })` scope.
- Static quoted strings only. No regular expressions, template expressions,
  computed/spread/shorthand options, dynamic names, custom helpers, `.first()`,
  filters, nested scopes, frames, arbitrary CSS, forced clicks, or custom action
  options. More than one action is unsupported rather than guessed at.

TypeScript's AST identifies and re-verifies the exact receiver range of the
action call. The replacement is generated from an enumerated `LocatorSpec`;
the provider cannot supply source code. Both the untouched prefix and suffix
are checked after reparsing. A forged range or operation/role mismatch is rejected.

## DOM candidates and privacy boundary

Candidates come from the current live page's visible, enabled button/textbox roles.
Names are read through Playwright ARIA snapshots, labels from associated native
labels, and context from nearby authored control sections and accessible groups.
The fixture supports native labels/fieldsets. This is not a claim to implement the
entire accessible-name algorithm for arbitrary applications.

One role/label expression per control is retained; equivalent locator expressions
are deduplicated. Duplicate matches remain explicit non-unique candidates and
cannot be applied. Controls in named groups receive an exact group scope. Candidate
order is a SHA-256 sort over case ID and observed candidate content, not DOM
position, target truth, or provider. IDs `c1`, `c2`, ... encode only that order.
All providers receive the same finite choices.

The decision request contains the pre-authored intent, old locator and observed
old context, and current candidate names/labels/context. It never contains
internal control keys, independent expected state, target truth, expected choice,
or evaluator output. Providers receive a detached copy so mutations cannot alter
the validated candidate map. Ground truth is consulted only on the evaluator side.

## Independent evaluation

`fixtures/oracles/index.ts` declares desired business states separately from app
effect handlers and visible names. The fixture server records the actual control
used and actual resulting state. A valid repair requires all of:

1. The same original assertions pass.
2. The intended semantic control was used.
3. The independent business-state oracle passes.
4. The locator-only AST patch invariant holds.

Two rejected green outcomes are deliberately distinguished:

- **Wrong-target green:** original assertions passed after an unrelated action.
- **Right-target weak-assertion green:** the intended control was used but a
  simultaneous business regression was missed by the original weak assertion.

For regression variants, A intentionally uses a weak status assertion, while B
also asserts business state. Both must fail the independent oracle. Missing-target
families expect `NO_REPAIR`; indistinguishable approvals expect `ABSTAIN`. These
choices do not create a patched test. Invalid IDs and non-unique locators are
rejected before writing a patch.

## Dataset and independence

The manifest contains 30 authored business-scenario families, each with A/B
variants: 60 cases total. Each of the six categories contributes five families.
Within **each** category the first family is development, the second calibration,
and the remaining three final: 6/6/18 families (12/12/36 cases).

The family manifest, not generated wording, defines the split. A/B variants vary
DOM/control order, utility distractors, mobile group names, label-vs-role input
locators, or assertion strength. They never cross splits and are never counted as
independent examples. All cases share this small synthetic renderer and harness;
even distinct business families are not independent real-world applications or
evidence of general model performance. Report family-clustered results, disclose
these shared patterns, and do not inflate sample size through variant repetition.

## Owned resources and replay safety

The fixture server listens only on `127.0.0.1` with an OS-assigned ephemeral port.
Each session owns its browser, server, state, and randomly named workspace.
Browser requests are restricted to that session's loopback origin. Source files
in the repository are never modified. Both `capture` and `runCase` default to
the sibling `jev-playwright-repair-lab-private\workspaces` directory, with the
public repository root derived from the engine module's `import.meta.url`, not
the invocation directory. Callers can supply another private `workspaceRoot`,
but the repository root or any descendant is rejected **before any directory or
test file is created**. Existing symlink/junction aliases back into the public
checkout are rejected too. No execution workspace is allowed in the public
checkout, even briefly or when ignored by Git.

Owned trial directories are removed on success, provider
error, browser-launch failure, and validation rejection. The parent directory is
not recursively removed. Cleanup failures are explicit errors.

The VM harness and disposable workspace are **not a security sandbox** and must
not run untrusted user tests. No real service or user data is used.

`beforeHtml`/`afterHtml` are static pre-action snapshots for keyless replay:
scripts, event handlers, frames, active resource URLs and internal action keys
are removed. Even error fallback snapshots are generated without scripts. A
replay viewer should still use a sandboxed iframe without script permissions.
Do not label static replay as a live browser/API run.

## Local validation

For reproducibility, the root dependency is pinned to `@playwright/test` **1.61.1**,
whose official browser manifest specifies Chromium revision **1228**
(Chromium **149.0.7827.55**). This explicit dependency/browser pairing was selected
after downloads for a newer Playwright revision were unavailable. Local execution
and CI use the same pinned package and its matching browser installation.

The engine calls `chromium.launch({ headless: true })` with neither an
`executablePath` nor a browser `channel`. It never silently substitutes cached
Chromium from another revision, system Chrome, or Edge. An unavailable matching
browser is reported as an infrastructure failure, not a repaired test.

Use the repository's existing Vitest installation:

```powershell
npx vitest run packages\engine\src
```

If the root Vitest configuration separates browser suites, run its browser
configuration as well; verify that discovery includes
`packages\engine\src\browser.test.ts`. A successful unit-only run is not evidence
that Chromium execution passed. The browser suite includes an actual `tsx`
subprocess to catch browser-evaluation serialization differences from Vitest's
transform.

The browser suite is deliberately scoped to baseline/repair, label fill, group
movement, passing/assertion/unsupported guards, removal, ambiguity, wrong-target
green, simultaneous rename/regression, bad IDs, and owned-workspace cleanup.
Missing Chromium is a real infrastructure error, never a skipped/faked success;
install the repository-pinned Playwright Chromium before running browser tests.
