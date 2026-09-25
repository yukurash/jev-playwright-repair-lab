import type { ProviderId, TrialResult } from "@repair-lab/core";

export function summarize(trials: readonly TrialResult[]) {
  const providers: ProviderId[] = ["rule", "azure", "jev"];
  return providers.map((provider) => {
    const rows = trials.filter((trial) => trial.provider === provider);
    const repairable = rows.filter((trial) => trial.repairable);
    const decisions = rows.filter((trial) => trial.decision !== null);
    const successes = repairable.filter((trial) =>
      trial.status === "repaired" && trial.targetCorrect === true &&
      trial.originalTestPassed === true && trial.oraclePassed === true);
    const latencies = decisions.map((trial) => trial.latency.decisionMs).sort((a, b) => a - b);
    const totals = decisions.map((trial) => trial.latency.totalMs).sort((a, b) => a - b);
    const costs = rows.flatMap((trial) => trial.costUsd === undefined ? [] : [trial.costUsd]);
    return {
      provider,
      trials: rows.length,
      families: new Set(rows.map((trial) => trial.familyId)).size,
      repairableTrials: repairable.length,
      correctRepairs: successes.length,
      correctRepairRate: repairable.length ? successes.length / repairable.length : null,
      decisions: decisions.length,
      wrongTargetGreen: rows.filter((trial) => trial.originalTestPassed === true && trial.targetCorrect === false).length,
      rightTargetRegressionGreen: rows.filter((trial) =>
        trial.originalTestPassed === true && trial.targetCorrect === true && trial.oraclePassed === false).length,
      correctNoRepair: rows.filter((trial) => trial.expectedDecision === "NO_REPAIR" && trial.decision === "NO_REPAIR").length,
      abstentions: rows.filter((trial) => trial.decision === "ABSTAIN").length,
      guards: rows.filter((trial) => trial.status === "unsupported" || trial.status === "unchanged").length,
      errors: rows.filter((trial) => trial.status === "error").length,
      decisionLatencyObservations: latencies.length,
      decisionLatencyP50Ms: quantile(latencies, 0.5),
      decisionLatencyP95Ms: quantile(latencies, 0.95),
      totalLatencyP50Ms: quantile(totals, 0.5),
      costObservations: costs.length,
      observedCostUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      missingCostTrials: rows.length - costs.length,
    };
  });
}

function quantile(sorted: number[], fraction: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
}
