import { performance } from "node:perf_hooks";
import { validateChoice, type DecisionProvider, type LocatorSpec } from "../../core/src/index.js";
import { canonicalRequest } from "./decision.js";

function name(locator: LocatorSpec): string {
  return (locator.kind === "role" ? locator.name : locator.label).normalize("NFKC").toLowerCase().trim();
}

function words(value: string): Set<string> {
  return new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  return [...left].filter((word) => right.has(word)).length / new Set([...left, ...right]).size;
}

export function createRuleProvider(): DecisionProvider {
  return {
    id: "rule",
    async decide(input) {
      const started = performance.now();
      const request = canonicalRequest(input);
      const oldName = name(request.oldLocator);
      const oldWords = words(`${oldName} ${request.intent}`);
      const ranked = request.candidates
        .filter((candidate) => request.operation === "click"
          ? candidate.locator.kind === "role" && candidate.locator.role === "button"
          : candidate.locator.kind === "label" || candidate.locator.role === "textbox")
        .map((candidate) => ({
          candidate,
          score: (name(candidate.locator) === oldName ? 4 : 0)
            + overlap(oldWords, words(name(candidate.locator))) * 2
            + overlap(words(request.oldContext), words(candidate.context))
            + (request.oldLocator.scope && request.oldLocator.scope === candidate.locator.scope ? 1 : 0),
        }))
        .sort((a, b) => b.score - a.score);
      const first = ranked[0];
      const second = ranked[1];
      const selected = !first || first.score === 0 ? "NO_REPAIR"
        : second && first.score === second.score ? "ABSTAIN" : first.candidate.id;
      return {
        choice: validateChoice(selected, request), model: "deterministic-lexical-v1",
        latencyMs: performance.now() - started, costUsd: 0,
      };
    },
  };
}
