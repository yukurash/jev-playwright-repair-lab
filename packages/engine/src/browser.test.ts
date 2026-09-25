import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DecisionProvider, DecisionRequest } from "../../core/src/index.js";
import { capture, runCase } from "./index.js";
import { privateWorkspaceRoot, repositoryRoot } from "./workspace.js";
import { NEUTRAL_CONTROL_HELP } from "../../../fixtures/cases/index.js";

function select(predicate: (candidate: DecisionRequest["candidates"][number]) => boolean): DecisionProvider {
  return {
    id: "rule",
    async decide(request) {
      const candidate = request.candidates.find(predicate);
      if (!candidate) throw new Error("Test provider did not find its explicitly requested candidate");
      return { choice: candidate.id, model: "test-only-selector", latencyMs: 0 };
    },
  };
}

const noCall: DecisionProvider = {
  id: "rule",
  async decide() { throw new Error("Guard incorrectly invoked the provider"); },
};

describe("real Chromium locator repair", () => {
  it.each(["checkout-order-b", "contact-email-b", "indistinguishable-approval-b"])("exposes identical neutral helpers for live candidates in %s", async (caseId) => {
    const result = await capture(caseId);
    expect(result.status).toBe("repairable");
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.request?.oldContext).toContain(NEUTRAL_CONTROL_HELP);
    for (const candidate of result.candidates) {
      expect(candidate.context).toContain(NEUTRAL_CONTROL_HELP);
      expect(candidate.context).not.toMatch(/Changes take effect immediately|This control performs|Pending reimbursement|General navigation/);
    }
  }, 20_000);

  it("captures named group context under the actual tsx CLI transform", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import assert from "node:assert/strict";
       import { capture } from "./packages/engine/src/index.ts";
       const result = await capture("newsletter-preferences-a");
       assert.equal(result.status, "repairable");
       assert.equal(result.request.oldLocator.scope, "Email preferences");
       assert.ok(result.candidates.some(candidate => candidate.locator.scope === "Newsletter delivery"));
       console.log("tsx-browser-capture-passed");`,
    ], { cwd: repositoryRoot, timeout: 15_000 });
    expect(stdout).toContain("tsx-browser-capture-passed");
  }, 20_000);

  it("executes the unchanged original before and after, repairs, then reruns unchanged assertions", async () => {
    const result = await runCase("checkout-order-a", select((candidate) => candidate.locator.kind === "role" && candidate.locator.name === "Buy these items"));
    expect(result.error).toBeUndefined();
    expect(result.baselinePassed).toBe(true);
    expect(result.status).toBe("repaired");
    expect(result.originalTestPassed).toBe(true);
    expect(result.oraclePassed).toBe(true);
    expect(result.targetCorrect).toBe(true);
    expect(result.repairedTest).toContain('toHaveText("Order received")');
    expect(result.beforeHtml + result.afterHtml).not.toMatch(/<script|\son[a-z]+\s*=|javascript:|<iframe/i);
  }, 20_000);

  it("captures a supported label/fill request using live DOM and no oracle data", async () => {
    const result = await capture("contact-email-a");
    expect(result.status).toBe("repairable");
    expect(result.baselinePassed).toBe(true);
    expect(result.originalTestPassed).toBe(false);
    expect(result.request?.operation).toBe("fill");
    expect(result.candidates.some((candidate) => candidate.locator.kind === "label" && candidate.locator.label === "Contact address")).toBe(true);
    expect(JSON.stringify(result.request)).not.toMatch(/targetKey|expectedDecision|oraclePassed|k1|k2/);
    expect(result.candidates.every((candidate) => /^c\d+$/.test(candidate.id))).toBe(true);
  }, 20_000);

  it("repairs moved named-group scoping", async () => {
    const result = await runCase("newsletter-preferences-a", select((candidate) => candidate.locator.scope === "Newsletter delivery"));
    expect(result.status, result.error ?? result.reason).toBe("repaired");
  }, 20_000);

  it("retains gateway provenance without inventing a pinned Jev version", async () => {
    const selector = select((candidate) => candidate.locator.kind === "role" && candidate.locator.name === "Buy these items");
    const result = await runCase("checkout-order-a", {
      id: "jev",
      async decide(request) {
        return { ...await selector.decide(request), model: "typesafe-ai/jev", route: "vercel-ai-gateway" };
      },
    });
    expect(result.status).toBe("repaired");
    expect(result.route).toBe("vercel-ai-gateway");
    expect(result.modelVersion).toBeUndefined();
  }, 20_000);

  it("repairs a label/fill operation without changing its value", async () => {
    const result = await runCase("contact-email-a", select((candidate) => candidate.locator.kind === "label" && candidate.locator.label === "Contact address"));
    expect(result.status, result.error ?? result.reason).toBe("repaired");
    expect(result.oraclePassed).toBe(true);
    expect(result.repairedTest).toContain('.fill("reader@example.test")');
  }, 20_000);

  it.each(["assertion-only-total-a", "passing-layout-control-b", "dynamic-locator-a", "helper-locator-b", "unsafe-locator-options-a", "unsafe-locator-options-b"])("never invokes a provider for guard %s", async (caseId) => {
    const result = await runCase(caseId, noCall);
    expect(result.error).toBeUndefined();
    expect(result.baselinePassed).toBe(true);
    expect(result.model).toBe("not-called");
    expect(result.decision).toBeNull();
    expect(result.status).toBe(caseId.startsWith("passing") ? "unchanged" : caseId.startsWith("assertion") ? "rejected" : "unsupported");
  }, 20_000);

  it("does not label a deterministic guard as live inference for a requested model provider", async () => {
    const result = await runCase("passing-layout-control-a", { ...noCall, id: "azure" });
    expect(result.status).toBe("unchanged");
    expect(result.model).toBe("not-called");
    expect(result.inference).toBe("deterministic");
    expect(result.decision).toBeNull();
  }, 20_000);

  it("does not repair a removed target and records NO_REPAIR", async () => {
    const result = await runCase("deleted-coupon-a", { id: "rule", async decide() { return { choice: "NO_REPAIR", model: "test-only-no-repair", latencyMs: 0 }; } });
    expect(result.status).toBe("rejected");
    expect(result.expectedDecision).toBe("NO_REPAIR");
    expect(result.repairable).toBe(false);
    expect(result.repairedTest).toBeUndefined();
  }, 20_000);

  it("rejects a duplicate locator without using first or force", async () => {
    const result = await runCase("indistinguishable-approval-a", select((candidate) => candidate.locator.kind === "role" && candidate.locator.name === "Approve"));
    expect(result.error).toBeUndefined();
    expect(result.expectedDecision).toBe("ABSTAIN");
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("not unique");
    expect(result.repairedTest).toBeUndefined();
  }, 20_000);

  it("distinguishes wrong-target green from a correct repair", async () => {
    const result = await runCase("draft-or-publish-a", select((candidate) => candidate.locator.scope === "Internal draft"));
    expect(result.status, result.error).toBe("rejected");
    expect(result.originalTestPassed).toBe(true);
    expect(result.targetCorrect).toBe(false);
    expect(result.oraclePassed).toBe(false);
    expect(result.reason).toContain("Wrong-target green");
  }, 20_000);

  it.each(["a", "b"])("checks a simultaneous rename/regression with %s assertion strength", async (variant) => {
    const result = await runCase(`payment-double-charge-${variant}`, select((candidate) => candidate.locator.kind === "role" && candidate.locator.name === "Collect payment"));
    expect(result.status, result.error).toBe("rejected");
    expect(result.targetCorrect).toBe(true);
    expect(result.oraclePassed).toBe(false);
    expect(result.originalTestPassed).toBe(variant === "a");
    if (variant === "a") expect(result.reason).toContain("Right-target weak-assertion green");
  }, 20_000);

  it("rejects a provider-invented ID and ignores provider input mutation", async () => {
    const result = await runCase("checkout-order-b", {
      id: "rule",
      async decide(request) {
        request.candidates.push({ id: "c99999", locator: { kind: "role", role: "button", name: "Buy these items" }, context: "injected" });
        return { choice: "c99999", model: "test-only-invalid", latencyMs: 0 };
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("outside the allowed");
    expect(result.candidates.some((candidate) => candidate.id === "c99999")).toBe(false);
    expect(result.repairedTest).toBeUndefined();
  }, 20_000);

  it("cleans only its own private workspace after provider errors", async () => {
    const root = await privateWorkspaceRoot();
    await mkdir(root, { recursive: true });
    const workspaceRoot = await mkdtemp(join(root, "cleanup-test-"));
    try {
      const result = await runCase("checkout-order-a", { id: "rule", async decide() { throw new Error("Deliberate provider failure"); } }, { workspaceRoot });
      expect(result.status).toBe("error");
      expect(result.error).toBe("Deliberate provider failure");
      expect(await readdir(workspaceRoot)).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects workspace roots inside the public checkout before starting a browser", async () => {
    const result = await runCase("checkout-order-a", noCall, { workspaceRoot: join(repositoryRoot, ".forbidden-workspaces") });
    expect(result.status).toBe("error");
    expect(result.error).toContain("outside the public checkout");
    expect(result.model).toBe("not-called");
  });
});
