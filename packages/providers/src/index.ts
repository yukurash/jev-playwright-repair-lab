import type { DecisionProvider, ProviderId } from "../../core/src/index.js";
import { validateConfiguration, type ProviderConfiguration } from "./configuration.js";
import { ProviderError } from "./errors.js";
import { buildLiveProvider } from "./live.js";
import { createRuleProvider } from "./rule.js";

export { BudgetLedger, committedNanos, MAX_BUDGET_USD, usdToNanos, type BudgetSnapshot, type Reservation } from "./budget.js";
export {
  AZURE_TOKEN_SCOPE, DEFAULT_LEDGER_PATH, JEV_MODEL, GATEWAY_JEV_MODEL, loadConfiguration, inspectConfiguration,
  type ConfigurationInspection, type Pricing, type ProviderConfiguration,
} from "./configuration.js";
export { ProviderError } from "./errors.js";

export function createProvider(id: ProviderId, config?: ProviderConfiguration): DecisionProvider {
  if (id === "rule") return createRuleProvider();
  if (id !== "azure" && id !== "jev") throw new ProviderError("UNKNOWN_PROVIDER", "Unknown decision provider");
  if (!config) throw new ProviderError("MISSING_CONFIGURATION", "Live providers require explicit private configuration");
  return buildLiveProvider(id, validateConfiguration(config));
}
