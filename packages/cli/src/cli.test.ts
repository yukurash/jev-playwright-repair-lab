import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./index.ts", import.meta.url));

it("doctor is free, reports missing live readiness, and lists the authored cases", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-cli-doctor-"));
  try {
    const output = execFileSync(process.execPath, ["--import", "tsx", script, "doctor", "--private-dir", directory], { encoding: "utf8" });
    const result = JSON.parse(output);
    expect(result.mode).toContain("no model API calls");
    expect(result.inspection.ready).toBe(false);
    expect(result.cases).toHaveLength(60);
    expect(new Set(result.cases.map((item: { familyId: string }) => item.familyId)).size).toBe(30);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

it("refuses a model repair unless --live is explicit, before any inference", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "repair", "--case", "unused", "--provider", "azure"], { encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("requires explicit --live");
});
