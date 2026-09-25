import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startFixture, renderPage, type FixtureServer } from "../../../apps/fixture/src/index.js";
import { cases, datasetManifest, getCase, type FixtureCase } from "../../../fixtures/cases/index.js";
import { evaluateOracle, oracleFor } from "../../../fixtures/oracles/index.js";
import { validateChoice, type Candidate, type DecisionProvider, type DecisionRequest, type ProviderResult, type TrialResult } from "../../core/src/index.js";
import { analyzeTest, patchLocator, UnsupportedTestError, type ActionSite } from "./patch.js";
import { candidateKeys, enumerateCandidates, executeTest, isActionFailure, oldContextFor, resolveLocator, staticSnapshot, type TestExecution } from "./browser.js";
import { privateWorkspaceRoot } from "./workspace.js";

export { cases, datasetManifest, analyzeTest, patchLocator, UnsupportedTestError };
export type { CaseMetadata } from "../../../fixtures/cases/index.js";

export interface CaptureResult {
  caseId: string;
  request: DecisionRequest | null;
  baselinePassed: boolean;
  originalTestPassed: boolean | null;
  status: "repairable" | "unchanged" | "unsupported" | "assertion-only" | "baseline-failed";
  reason?: string;
  beforeHtml: string;
  afterHtml: string;
  originalTest: string;
  candidates: Candidate[];
}

interface Session {
  fixture: FixtureCase;
  server: FixtureServer;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  workspace: string;
  originalPath: string;
}

interface CaptureInternal {
  public: CaptureResult;
  site: ActionSite | null;
  afterExecution: TestExecution;
}

async function openSession(fixture: FixtureCase, workspaceRoot?: string): Promise<Session> {
  const root = await privateWorkspaceRoot(workspaceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const checkedRoot = await privateWorkspaceRoot(root);
  const workspace = await mkdtemp(join(checkedRoot, "trial-"));
  let server: FixtureServer | undefined;
  let browser: Browser | undefined;
  try {
    const originalPath = join(workspace, "original.spec.js");
    await writeFile(originalPath, fixture.originalTest, { encoding: "utf8", mode: 0o600, flag: "wx" });
    server = await startFixture(fixture);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
    const page = await context.newPage();
    const allowedOrigin = new URL(server.url("before")).origin;
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== allowedOrigin) await route.abort("blockedbyclient");
      else await route.continue();
    });
    return { fixture, server, browser, context, page, workspace, originalPath };
  } catch (error) {
    try {
      if (browser) await browser.close();
    } finally {
      try {
        if (server) await server.close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function closeSession(session: Session): Promise<void> {
  try {
    await session.browser.close();
  } finally {
    try {
      await session.server.close();
    } finally {
      await rm(session.workspace, { recursive: true, force: true });
    }
  }
}

async function inspect(session: Session): Promise<CaptureInternal> {
  const { fixture, page, server, originalPath } = session;
  let site: ActionSite | null = null;
  let unsupportedReason: string | undefined;
  try {
    site = analyzeTest(fixture.originalTest);
  } catch (error) {
    if (!(error instanceof UnsupportedTestError)) throw error;
    unsupportedReason = error.message;
  }
  await page.goto(server.url("before"));
  const beforeHtml = await staticSnapshot(page);
  const oldContext = site ? await oldContextFor(page, site.locator) : "";
  const baseline = await executeTest(page, originalPath, server.url("before"));
  server.reset("after");
  await page.goto(server.url("after"));
  const afterHtml = await staticSnapshot(page);
  const after = await executeTest(page, originalPath, server.url("after"));
  const result: CaptureResult = {
    caseId: fixture.id, request: null, baselinePassed: baseline.passed,
    originalTestPassed: after.passed, status: "repairable",
    beforeHtml, afterHtml, originalTest: fixture.originalTest, candidates: [],
  };
  if (!baseline.passed) {
    result.status = "baseline-failed";
    result.reason = `Original test failed against unchanged app: ${baseline.error ?? "unknown failure"}`;
  } else if (after.passed) {
    result.status = "unchanged";
    result.reason = "The unchanged original test already passes; no model or patch is needed";
  } else if (!site) {
    result.status = "unsupported";
    result.reason = unsupportedReason ?? "Unsupported original test";
  } else if (!isActionFailure(after, site)) {
    result.status = after.failureLine === null ? "unsupported" : "assertion-only";
    result.reason = after.failureLine === null
      ? "The failed source location could not be verified; refusing to patch"
      : `Failure at source line ${after.failureLine}, outside locator action lines ${site.startLine}-${site.endLine}; no model invoked`;
  } else if (await resolveLocator(page, site.locator).count() === 1) {
    result.status = "unsupported";
    result.reason = "The original locator still resolves uniquely; non-locator action failures are not repaired";
  } else {
    // Enumerate a clean, current page, not DOM modified by a previous test attempt.
    server.reset("after");
    await page.goto(server.url("after"));
    result.candidates = await enumerateCandidates(page, fixture.id, site);
    result.request = {
      caseId: fixture.id, intent: fixture.intent, operation: site.operation,
      oldLocator: site.locator, oldContext, candidates: result.candidates,
    };
  }
  return { public: result, site, afterExecution: after };
}

export async function capture(caseId: string): Promise<CaptureResult> {
  const session = await openSession(getCase(caseId));
  try {
    return (await inspect(session)).public;
  } finally {
    await closeSession(session);
  }
}

function baseResult(fixture: FixtureCase, provider: DecisionProvider, options: { sourceSha?: string }): TrialResult {
  return {
    schemaVersion: 1, caseId: fixture.id, familyId: fixture.familyId, split: fixture.split,
    category: fixture.category, title: fixture.title, provider: provider.id, model: "not-called",
    status: "error", decision: null, expectedDecision: null, baselinePassed: false,
    originalTestPassed: null, oraclePassed: null, targetCorrect: null, repairable: false,
    beforeHtml: renderPage(fixture.before), afterHtml: renderPage(fixture.after),
    originalTest: fixture.originalTest, candidates: [],
    latency: { captureMs: 0, decisionMs: 0, validationMs: 0, totalMs: 0 },
    sourceSha: options.sourceSha ?? "unrecorded", recordedAt: new Date().toISOString(),
    inference: "deterministic",
  };
}

async function expectedDecision(page: Page, fixture: FixtureCase, candidates: Candidate[]): Promise<string | null> {
  const oracle = oracleFor(fixture);
  if (oracle.selection !== "target") return oracle.selection;
  for (const candidate of candidates) {
    const keys = await candidateKeys(page, candidate);
    if (keys.length === 1 && keys[0] === oracle.targetKey) return candidate.id;
  }
  return null;
}

function copyProviderResult(result: TrialResult, decision: ProviderResult): void {
  result.model = decision.model;
  if (decision.modelVersion !== undefined) result.modelVersion = decision.modelVersion;
  if (decision.route !== undefined) result.route = decision.route;
  if (decision.usage !== undefined) result.usage = decision.usage;
  if (decision.costUsd !== undefined) result.costUsd = decision.costUsd;
  if (decision.confidence !== undefined) result.confidence = decision.confidence;
  if (decision.probabilities !== undefined) result.probabilities = decision.probabilities;
}

export async function runCase(
  caseId: string,
  provider: DecisionProvider,
  options: { sourceSha?: string; workspaceRoot?: string } = {},
): Promise<TrialResult> {
  const fixture = getCase(caseId);
  const started = performance.now();
  const result = baseResult(fixture, provider, options);
  let session: Session | undefined;
  try {
    session = await openSession(fixture, options.workspaceRoot);
    const captured = await inspect(session);
    const current = captured.public;
    result.latency.captureMs = performance.now() - started;
    Object.assign(result, {
      baselinePassed: current.baselinePassed, originalTestPassed: current.originalTestPassed,
      beforeHtml: current.beforeHtml, afterHtml: current.afterHtml, candidates: current.candidates,
    });
    if (current.status !== "repairable" || !current.request || !captured.site) {
      result.status = current.status === "unchanged" ? "unchanged"
        : current.status === "unsupported" ? "unsupported"
        : current.status === "baseline-failed" ? "error" : "rejected";
      if (current.reason !== undefined) result.reason = current.reason;
      if (current.baselinePassed && captured.afterExecution.passed) {
        Object.assign(result, evaluateOracle(fixture, session.server.observation("after")));
      }
      return result;
    }
    result.expectedDecision = await expectedDecision(session.page, fixture, current.candidates);
    result.repairable = oracleFor(fixture).selection === "target" && fixture.category !== "regression" && result.expectedDecision !== null;
    const decisionStarted = performance.now();
    let decision: ProviderResult;
    try {
      // A detached input prevents a provider from mutating candidates or the patch map.
      result.inference = provider.id === "rule" ? "deterministic" : "live";
      decision = await provider.decide(structuredClone(current.request));
    } finally {
      result.latency.decisionMs = performance.now() - decisionStarted;
    }
    copyProviderResult(result, decision);
    result.decision = decision.choice;
    try {
      validateChoice(decision.choice, current.request);
    } catch (error) {
      result.status = "rejected";
      result.reason = error instanceof Error ? error.message : String(error);
      return result;
    }
    if (decision.choice === "ABSTAIN" || decision.choice === "NO_REPAIR") {
      result.status = decision.choice === "ABSTAIN" ? "abstained" : "rejected";
      result.reason = decision.choice === "ABSTAIN" ? "Provider abstained; no source changed" : "Provider selected NO_REPAIR; no source changed";
      return result;
    }
    const validationStarted = performance.now();
    try {
      const chosen = current.candidates.find((candidate) => candidate.id === decision.choice);
      if (!chosen) throw new Error("Validated candidate disappeared from the immutable candidate map");
      const locator = resolveLocator(session.page, chosen.locator);
      if (await locator.count() !== 1) {
        result.status = "rejected";
        result.reason = "Selected locator is not unique; .first() and force are never applied";
        return result;
      }
      if (!await locator.isVisible() || !await locator.isEnabled()) {
        result.status = "rejected";
        result.reason = "Selected candidate is no longer visible and actionable";
        return result;
      }
      const repairedTest = patchLocator(fixture.originalTest, captured.site, chosen.locator);
      const patchedPath = join(session.workspace, "repaired.spec.js");
      await writeFile(patchedPath, repairedTest, { encoding: "utf8", mode: 0o600, flag: "wx" });
      result.repairedTest = repairedTest;
      session.server.reset("after");
      const execution = await executeTest(session.page, patchedPath, session.server.url("after"));
      result.originalTestPassed = execution.passed;
      Object.assign(result, evaluateOracle(fixture, session.server.observation("after")));
      result.status = execution.passed && result.targetCorrect && result.oraclePassed ? "repaired" : "rejected";
      result.reason = result.status === "repaired" ? "Original assertions and independent semantic/business oracle passed"
        : execution.passed && !result.targetCorrect ? "Wrong-target green: original assertions passed but a different semantic control was used"
        : execution.passed && !result.oraclePassed ? "Right-target weak-assertion green: original assertions passed but business state is wrong"
        : `Repaired locator did not make the original test pass: ${execution.error ?? "unknown failure"}`;
    } finally {
      result.latency.validationMs = performance.now() - validationStarted;
    }
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : String(error);
    result.reason = "Execution failed; no provider fallback or synthetic result was used";
  } finally {
    try {
      if (session) await closeSession(session);
    } catch (error) {
      result.status = "error";
      result.error = `Owned-resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    result.latency.totalMs = performance.now() - started;
  }
  return result;
}
