import { expect, it } from "vitest";
import { parseManifest } from "./manifest.js";

const manifest = {
  schemaVersion: 1,
  sourceSha: "a".repeat(40),
  split: "final",
  caseIds: ["one-a", "one-b"],
  providers: ["rule", "azure", "jev"],
  repetitions: 3,
  seed: 42,
  frozenAt: "2026-09-24T00:00:00.000Z",
  lockfileSha256: "b".repeat(64),
  instructionSha256: "c".repeat(64),
  providerConfigSha256: null,
};
it("accepts frozen manifests and rejects duplicate cases and unbounded repetitions", () => {
  expect(parseManifest(manifest).providers).toHaveLength(3);
  expect(() => parseManifest({ ...manifest, caseIds: ["one", "one"] })).toThrow();
  expect(() => parseManifest({ ...manifest, repetitions: 10000 })).toThrow();
  expect(() => parseManifest({ ...manifest, providers: ["other"] })).toThrow();
  expect(() => parseManifest({ ...manifest, sourceSha: "dirty" })).toThrow();
});
