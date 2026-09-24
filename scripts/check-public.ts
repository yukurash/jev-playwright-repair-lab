import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPublicText, inspectSnapshot } from "./public-policy.js";
import { assertTrial } from "@repair-lab/experiment";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean);
const errors: string[] = [];
async function inspect(path: string): Promise<void> {
  const stat = await lstat(join(root, path));
  if (stat.isSymbolicLink()) {
    errors.push(`${path}: symlinks must not bypass the publication boundary`);
    return;
  }
  errors.push(...inspectPublicText(path, await readFile(join(root, path), "utf8")));
}
for (const path of files) await inspect(path);
async function walk(path: string): Promise<void> {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) await walk(child);
    else await inspect(child);
  }
}
await walk("apps/demo/dist");
const dataset: unknown = JSON.parse(await readFile(join(root, "data/public/results.json"), "utf8"));
if (!dataset || typeof dataset !== "object" || !("trials" in dataset) || !Array.isArray(dataset.trials)) {
  throw new Error("Public dataset schema is invalid");
}
if (dataset.trials.length && (!("publicationApproved" in dataset) || dataset.publicationApproved !== true)) {
  errors.push("Public measurements require publication approval");
}
for (const trial of dataset.trials) {
  assertTrial(trial);
  errors.push(...inspectSnapshot(trial.beforeHtml), ...inspectSnapshot(trial.afterHtml));
}
if (errors.length) throw new Error(`Public boundary check failed:\n${errors.join("\n")}`);
console.log(`Public boundary checked: ${files.length} source files, built demo, and ${dataset.trials.length} recorded trials.`);
