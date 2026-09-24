import { describe, expect, it } from "vitest";
import { decisionContext, validateChoice, type DecisionRequest } from "./index.js";

const request: DecisionRequest = {
  caseId: "hidden-case-id",
  intent: "Save account settings",
  operation: "click",
  oldLocator: { kind: "role", role: "button", name: "Save" },
  oldContext: "Account",
  candidates: [{ id: "c0", locator: { kind: "role", role: "button", name: "Update" }, context: "Account" }],
};

describe("finite decision contract", () => {
  it("accepts only candidate IDs and explicit non-repair choices", () => {
    expect(validateChoice("c0", request)).toBe("c0");
    expect(validateChoice("NO_REPAIR", request)).toBe("NO_REPAIR");
    expect(validateChoice("ABSTAIN", request)).toBe("ABSTAIN");
    expect(() => validateChoice("c99", request)).toThrow();
    expect(() => validateChoice({ choice: "c0" }, request)).toThrow();
  });
  it("does not disclose case IDs to models", () => {
    expect(decisionContext(request)).not.toContain("hidden-case-id");
  });
  it("rejects answer-bearing or duplicate candidate IDs", () => {
    expect(() => validateChoice("correct", { ...request, candidates: [{ ...request.candidates[0]!, id: "correct" }] })).toThrow();
    expect(() => decisionContext({ ...request, candidates: [...request.candidates, ...request.candidates] })).toThrow();
  });
});
