import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

it("free clean-checkout workflow freezes, evaluates, summarizes, and exports the complete development split", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "repair-workflow-"));
  const checkout = join(temporary, "checkout");
  await mkdir(checkout);
  try {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean);
    for (const file of files) {
      await mkdir(dirname(join(checkout, file)), { recursive: true });
      await cp(join(repository, file), join(checkout, file));
    }
    const modules = join(checkout, "node_modules");
    await mkdir(modules);
    for (const name of await readdir(join(repository, "node_modules"))) {
      if (name === "@repair-lab" || name.startsWith(".")) continue;
      await symlink(join(repository, "node_modules", name), join(modules, name), "junction");
    }
    await mkdir(join(modules, "@repair-lab"));
    for (const [name, path] of [
      ["core", "packages/core"], ["engine", "packages/engine"],
      ["providers", "packages/providers"], ["experiment", "packages/experiment"],
      ["fixture", "apps/fixture"],
    ]) {
      await symlink(join(checkout, path!), join(modules, "@repair-lab", name!), "junction");
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-b", "main");
    git("add", ".");
    git("-c", "user.name=yukurash", "-c", "user.email=152368380+yukurash@users.noreply.github.com",
      "commit", "-m", "test: isolate free CLI integration",
      "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
    const cli = (...args: string[]) => execFileSync(process.execPath, [
      "--import", pathToFileURL(join(repository, "node_modules", "tsx", "dist", "loader.mjs")).href,
      join(checkout, "packages", "cli", "src", "index.ts"), ...args,
    ], { cwd: checkout, encoding: "utf8", timeout: 120_000 });
    const frozen = JSON.parse(cli("freeze", "--split", "development", "--provider", "rule"));
    expect(frozen.scheduledTrials).toBe(12);
    const evaluation = cli("evaluate", "--manifest", frozen.manifest);
    const run = /"run": "([^"]+)"/.exec(evaluation)?.[1];
    expect(run).toBeDefined();
    const summary = JSON.parse(cli("summarize", "--run", run!));
    expect(summary[0].trials).toBe(12);
    expect(summary[1].trials).toBe(0);
    expect(summary[2].trials).toBe(0);
    cli("export-public", "--run", run!, "--confirm-publication");
    const exported = JSON.parse(await readFile(join(checkout, "data", "public", "results.json"), "utf8"));
    expect(exported.trials).toHaveLength(12);
    expect(exported.trials.every((trial: { inference: string }) => trial.inference === "deterministic")).toBe(true);
    expect(exported.sourceSha).toMatch(/^[a-f0-9]{40}$/);
    expect(exported.publicationApproved).toBe(true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
