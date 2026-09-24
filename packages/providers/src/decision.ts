import {
  choicesFor, decisionContext, type DecisionRequest, type LocatorSpec,
} from "../../core/src/index.js";
import { object, ProviderError, text } from "./errors.js";

function locator(value: unknown): LocatorSpec {
  const item = object(value, "locator");
  const scope = item.scope === undefined ? {} : { scope: text(item.scope, "scope") };
  if (item.kind === "label") return { kind: "label", label: text(item.label, "label"), ...scope };
  if (item.kind === "role" && (item.role === "button" || item.role === "textbox")) {
    return { kind: "role", role: item.role, name: text(item.name, "name"), ...scope };
  }
  throw new ProviderError("INVALID_INPUT", "Unsupported locator kind or role");
}

/** Rebuild the shared context from an allowlist; runtime-added oracle fields cannot leak. */
export function canonicalRequest(request: DecisionRequest): DecisionRequest {
  if (request.operation !== "click" && request.operation !== "fill") {
    throw new ProviderError("INVALID_INPUT", "Unsupported operation");
  }
  if (!Array.isArray(request.candidates) || request.candidates.length > 253) {
    throw new ProviderError("INVALID_INPUT", "The finite choice set supports at most 253 candidates");
  }
  const normalized: DecisionRequest = {
    caseId: "",
    intent: text(request.intent, "intent"),
    operation: request.operation,
    oldLocator: locator(request.oldLocator),
    oldContext: typeof request.oldContext === "string" ? request.oldContext : text(request.oldContext, "oldContext"),
    candidates: request.candidates.map((candidate) => ({
      id: text(candidate.id, "candidate ID"),
      locator: locator(candidate.locator),
      context: typeof candidate.context === "string" ? candidate.context : text(candidate.context, "context"),
    })),
  };
  choicesFor(normalized);
  if (Buffer.byteLength(decisionContext(normalized), "utf8") > 100_000) {
    throw new ProviderError("INPUT_LIMIT", "Decision context exceeds the hard input bound");
  }
  return normalized;
}
