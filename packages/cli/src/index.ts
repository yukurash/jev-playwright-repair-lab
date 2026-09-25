import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DECISION_INSTRUCTION, type DecisionProvider, type ProviderId, type TrialResult } from "@repair-lab/core";
import { capture, cases, runCase } from "@repair-lab/engine";
import { BudgetLedger, createProvider, inspectConfiguration, loadConfiguration } from "@repair-lab/providers";
import { assertPrivatePath, parseManifest, publicDataset, readTrials, shuffled, summarize, writeJsonExclusive, type ExperimentManifest } from "@repair-lab/experiment";
import { inspectPublicText, inspectSnapshot } from "../../../scripts/public-policy.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: "string" },
    provider: { type: "string" },
    manifest: { type: "string" },
    run: { type: "string" },
    config: { type: "string" },
    "private-dir": { type: "string" },
    split: { type: "string" },
    repetitions: { type: "string" },
    seed: { type: "string" },
    live: { type: "boolean", default: false },
    "confirm-publication": { type: "boolean", default: false },
    "confirm-new-budget": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const privateRoot = assertPrivatePath(values["private-dir"] ?? resolve(repository, "..", "jev-playwright-repair-lab-private"), repository);
const configPath = assertPrivatePath(values.config ?? join(privateRoot, "local-config", "providers.json"), repository);
const environmentPath = join(privateRoot, "local-config", "providers.env");
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function sourceSha(requireClean = false): string {
  const dirty = git("status", "--porcelain", "--untracked-files=all").length > 0;
  if (requireClean && dirty) throw new Error("Commit all experiment inputs before freezing or running a final evaluation");
  return git("rev-parse", "HEAD") + (dirty ? "-dirty" : "");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function providerId(value: string | undefined): ProviderId {
  if (value !== "rule" && value !== "azure" && value !== "jev") throw new Error("--provider must be rule, azure, or jev");
  return value;
}

async function provider(id: ProviderId): Promise<DecisionProvider> {
  if (id === "rule") return createProvider("rule");
  if (!values.live) throw new Error("Paid inference requires explicit --live and verified private configuration");
  return createProvider(id, await loadConfiguration(configPath));
}

function runPath(id: string): string {
  const path = assertPrivatePath(isAbsolute(id) ? id : join(privateRoot, "runs", id), repository);
  const rel = relative(join(privateRoot, "runs"), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("--run must identify a run directory beneath the configured private runs directory");
  }
  return path;
}

function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

async function saveRun(prefix: string, trials: TrialResult[], metadata: unknown): Promise<string> {
  const id = newRunId(prefix);
  const path = runPath(id);
  await writeJsonExclusive(join(path, "metadata.json"), metadata);
  await writeJsonExclusive(join(path, "results.json"), trials);
  await writeJsonExclusive(join(path, "summary.json"), summarize(trials));
  return id;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function inputHashes() {
  return {
    lockfileSha256: hash(await readFile(join(repository, "package-lock.json"), "utf8")),
    instructionSha256: hash(DECISION_INSTRUCTION),
  };
}

async function freeze(): Promise<void> {
  const split = values.split ?? "development";
  if (split !== "development" && split !== "calibration" && split !== "final") throw new Error("Unknown split");
  const selectedProviders: ProviderId[] = values.provider ? [providerId(values.provider)] : ["rule", "azure", "jev"];
  const config = selectedProviders.some((id) => id !== "rule") ? await loadConfiguration(configPath) : null;
  const manifest = parseManifest({
    schemaVersion: 1,
    sourceSha: sourceSha(true),
    split,
    caseIds: cases.filter((item) => item.split === split).map((item) => item.id),
    providers: selectedProviders,
    repetitions: Number(values.repetitions ?? (split === "final" ? "3" : "1")),
    seed: Number(values.seed ?? "42"),
    frozenAt: new Date().toISOString(),
    ...await inputHashes(),
    providerConfigSha256: config === null ? null : hash(JSON.stringify(config)),
  });
  const path = join(privateRoot, "runs", `${newRunId(`manifest-${split}`)}.json`);
  await writeJsonExclusive(path, manifest);
  console.log(JSON.stringify({ manifest: path, scheduledTrials: manifest.caseIds.length * manifest.repetitions * manifest.providers.length }, null, 2));
}

async function validateFrozen(manifest: ExperimentManifest): Promise<void> {
  if (sourceSha(true) !== manifest.sourceSha) throw new Error("Tested source SHA differs from the frozen manifest");
  const hashes = await inputHashes();
  if (hashes.lockfileSha256 !== manifest.lockfileSha256 || hashes.instructionSha256 !== manifest.instructionSha256) {
    throw new Error("Dependencies or instructions differ from the frozen manifest");
  }
  const config = manifest.providers.some((id) => id !== "rule") ? await loadConfiguration(configPath) : null;
  if ((config === null ? null : hash(JSON.stringify(config))) !== manifest.providerConfigSha256) {
    throw new Error("Provider configuration differs from the frozen manifest");
  }
  const expected = cases.filter((item) => item.split === manifest.split).map((item) => item.id).sort();
  if (JSON.stringify([...manifest.caseIds].sort()) !== JSON.stringify(expected)) {
    throw new Error("Manifest must contain the complete declared family split");
  }
}

async function evaluate(): Promise<void> {
  const path = assertPrivatePath(required(values.manifest, "manifest"), repository);
  const manifest = parseManifest(JSON.parse(await readFile(path, "utf8")));
  await validateFrozen(manifest);
  const providers = new Map<ProviderId, DecisionProvider>();
  for (const id of manifest.providers) providers.set(id, await provider(id));
  const config = manifest.providers.some((id) => id !== "rule") ? await loadConfiguration(configPath) : null;
  const id = newRunId(manifest.split);
  const directory = runPath(id);
  const schedule = shuffled(manifest.caseIds, manifest.seed).flatMap((caseId, index) =>
    Array.from({ length: manifest.repetitions }, (_, repetition) => {
      const offset = (index + repetition) % manifest.providers.length;
      const rotated = [...manifest.providers.slice(offset), ...manifest.providers.slice(0, offset)];
      return rotated.map((provider) => ({ caseId, provider, repetition }));
    }).flat());
  await writeJsonExclusive(join(directory, "manifest.json"), manifest);
  await writeJsonExclusive(join(directory, "metadata.json"), {
    status: "running", scheduledTrials: schedule.length,
    configSha256: config === null ? null : hash(JSON.stringify(config)),
    providerSettings: config === null ? null : {
      azure: config.azure && { model: config.azure.model, version: config.azure.modelVersion },
      jev: config.jev && {
        model: config.jev.model, route: config.jev.route ?? "typesafe",
        ...(config.jev.route === "vercel-ai-gateway" ? { provider: config.jev.provider, requireFree: config.jev.requireFree, freeUntil: config.jev.freeUntil } : {}),
      },
      limits: config.limits,
    },
  });
  await writeJsonExclusive(join(directory, "schedule.json"), schedule);
  const trials: TrialResult[] = [];
  let interrupted: string | null = null;
  try {
    for (const task of schedule) {
      const selected = providers.get(task.provider);
      if (!selected) throw new Error("Scheduled provider was not initialized");
      const result = await runCase(task.caseId, selected, {
        sourceSha: manifest.sourceSha,
        workspaceRoot: join(privateRoot, "workspaces"),
      });
      await writeJsonExclusive(join(directory, `trial-${String(trials.length).padStart(4, "0")}.json`), result);
      trials.push(result);
      console.log(`${trials.length}/${schedule.length} ${task.caseId} ${task.provider}: ${result.status}`);
      if (result.status === "error") throw new Error("Trial failed; stopping rather than retrying or concealing missing data");
    }
  } catch (error) {
    interrupted = error instanceof Error ? error.message : String(error);
  }
  await writeJsonExclusive(join(directory, "results.json"), trials);
  await writeJsonExclusive(join(directory, "summary.json"), summarize(trials));
  await writeJsonExclusive(join(directory, "completion.json"), {
    status: interrupted === null ? "completed" : "interrupted",
    expectedTrials: schedule.length,
    recordedTrials: trials.length,
    remainingTrials: schedule.slice(trials.length),
    error: interrupted,
  });
  console.log(JSON.stringify({ run: id, status: interrupted === null ? "completed" : "interrupted", recordedTrials: trials.length }, null, 2));
  if (interrupted) throw new Error(interrupted);
}

async function main(): Promise<void> {
  if (values.help || positionals.length !== 1) {
    console.log("Commands: doctor, capture --case ID, repair --case ID --provider rule|azure|jev [--live], freeze --split development|calibration|final, evaluate --manifest PATH [--live], summarize --run ID, export-public --run ID --confirm-publication, init-budget --confirm-new-budget");
    if (!values.help) process.exitCode = 2;
    return;
  }
  switch (positionals[0]) {
    case "doctor": {
      const inspection = await inspectConfiguration(existsSync(configPath) ? configPath : undefined);
      if (values.live) {
        const id = providerId(required(values.provider, "provider"));
        if (id === "rule") throw new Error("Live smoke expects azure or jev");
        const first = cases.find((item) => item.split === "development" && item.category === "rename");
        if (!first) throw new Error("No development smoke case available");
        const context = await capture(first.id);
        if (!context.request) throw new Error("Smoke case did not produce a repair request");
        const result = await (await provider(id)).decide(context.request);
        const output = join(privateRoot, "runs", `${newRunId("smoke")}.json`);
        await writeJsonExclusive(output, result);
        console.log(JSON.stringify({ smoke: "completed", output, result }, null, 2));
      } else {
        console.log(JSON.stringify({ mode: "read-only; no model API calls", inspection, cases: cases.map(({ id, familyId, split, category, title }) => ({ id, familyId, split, category, title })) }, null, 2));
      }
      break;
    }
    case "capture": {
      const captured = await capture(required(values.case, "case"));
      const output = join(privateRoot, "runs", `${newRunId("capture")}.json`);
      await writeJsonExclusive(output, captured);
      console.log(JSON.stringify({ output, ...captured }, null, 2));
      if (captured.status === "baseline-failed") process.exitCode = 2;
      break;
    }
    case "repair": {
      const id = providerId(values.provider ?? "rule");
      const result = await runCase(required(values.case, "case"), await provider(id), {
        sourceSha: sourceSha(), workspaceRoot: join(privateRoot, "workspaces"),
      });
      const run = await saveRun("repair", [result], { mode: "single-case", live: values.live });
      console.log(JSON.stringify({ run, ...result }, null, 2));
      if (result.status === "error" || result.status === "rejected" || result.status === "unsupported") process.exitCode = 2;
      break;
    }
    case "freeze":
      await freeze();
      break;
    case "evaluate":
      await evaluate();
      break;
    case "summarize": {
      const trials = await readTrials(join(runPath(required(values.run, "run")), "results.json"));
      console.log(JSON.stringify(summarize(trials), null, 2));
      break;
    }
    case "export-public": {
      const directory = runPath(required(values.run, "run"));
      const completionPath = join(directory, "completion.json");
      if (existsSync(completionPath)) {
        const completion: unknown = JSON.parse(await readFile(completionPath, "utf8"));
        if (typeof completion !== "object" || completion === null || !("status" in completion) || completion.status !== "completed") {
          throw new Error("This run is incomplete; inspect its private completion and summary records before considering publication");
        }
      }
      const trials = await readTrials(join(directory, "results.json"));
      if (trials.some((trial) => !/^[a-f0-9]{40}$/.test(trial.sourceSha))) throw new Error("Do not publish results from an uncommitted source tree");
      if (trials.some((trial) => trial.inference === "live")) {
        const config = await loadConfiguration(configPath);
        if (!config.approvals.publicationApproved) throw new Error("Live-result publication is not approved in private configuration");
      }
      const data = publicDataset(trials, values["confirm-publication"]);
      const text = `${JSON.stringify(data, null, 2)}\n`;
      const issues = inspectPublicText("data/public/results.json", text);
      for (const trial of data.trials) issues.push(...inspectSnapshot(trial.beforeHtml), ...inspectSnapshot(trial.afterHtml));
      if (issues.length) throw new Error(`Export rejected:\n${issues.join("\n")}`);
      const destination = join(repository, "data", "public", "results.json");
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(temporary, text, { flag: "wx" });
      await rename(temporary, destination);
      console.log(`Exported ${data.trials.length} allowlisted recorded trials; run npm run verify before publishing.`);
      break;
    }
    case "init-budget": {
      if (!values["confirm-new-budget"]) throw new Error("Only initialize a genuinely new budget with --confirm-new-budget; never reset an existing project budget");
      const config = await loadConfiguration(configPath);
      await new BudgetLedger(config.ledgerPath, config.budgetUsd).initialize();
      console.log("New project budget initialized exclusively; no API calls made.");
      break;
    }
    default:
      throw new Error(`Unknown command: ${positionals[0]}`);
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
