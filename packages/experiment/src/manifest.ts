import type { ProviderId, Split } from "@repair-lab/core";

export interface ExperimentManifest {
  schemaVersion: 1;
  sourceSha: string;
  split: Split;
  caseIds: string[];
  providers: ProviderId[];
  repetitions: number;
  seed: number;
  frozenAt: string;
  lockfileSha256: string;
  instructionSha256: string;
  providerConfigSha256: string | null;
}

export function parseManifest(value: unknown): ExperimentManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid experiment manifest");
  if (!("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("sourceSha" in value) || typeof value.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceSha) ||
      !("split" in value) || (value.split !== "development" && value.split !== "calibration" && value.split !== "final") ||
      !("caseIds" in value) || !Array.isArray(value.caseIds) || !value.caseIds.length ||
      !value.caseIds.every((id: unknown) => typeof id === "string" && /^[a-z0-9-]+$/.test(id)) ||
      new Set(value.caseIds).size !== value.caseIds.length ||
      !("providers" in value) || !Array.isArray(value.providers) || !value.providers.length ||
      !value.providers.every((id: unknown) => id === "rule" || id === "azure" || id === "jev") ||
      new Set(value.providers).size !== value.providers.length ||
      !("repetitions" in value) || !Number.isInteger(value.repetitions) || typeof value.repetitions !== "number" || value.repetitions < 1 || value.repetitions > 3 ||
      !("seed" in value) || typeof value.seed !== "number" || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffff_ffff ||
      !("frozenAt" in value) || typeof value.frozenAt !== "string" || !Number.isFinite(Date.parse(value.frozenAt)) ||
      !("lockfileSha256" in value) || typeof value.lockfileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.lockfileSha256) ||
      !("instructionSha256" in value) || typeof value.instructionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.instructionSha256) ||
      !("providerConfigSha256" in value) || (value.providerConfigSha256 !== null &&
        (typeof value.providerConfigSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.providerConfigSha256)))) {
    throw new Error("Invalid experiment manifest fields");
  }
  return {
    schemaVersion: 1,
    sourceSha: value.sourceSha,
    split: value.split,
    caseIds: value.caseIds,
    providers: value.providers,
    repetitions: value.repetitions,
    seed: value.seed,
    frozenAt: value.frozenAt,
    lockfileSha256: value.lockfileSha256,
    instructionSha256: value.instructionSha256,
    providerConfigSha256: value.providerConfigSha256,
  };
}
