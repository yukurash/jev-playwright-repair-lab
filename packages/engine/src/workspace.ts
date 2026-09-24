import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const defaultWorkspaceRoot = resolve(repositoryRoot, "..", "jev-playwright-repair-lab-private", "workspaces");

function isWithin(path: string, parent: string): boolean {
  const remainder = relative(parent, path);
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

async function canonicalPotentialPath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Validate before creating anything, including non-existing paths and junction aliases. */
export async function privateWorkspaceRoot(requested?: string): Promise<string> {
  const path = resolve(requested ?? defaultWorkspaceRoot);
  if (isWithin(path, repositoryRoot)) throw new Error("Workspace root must be outside the public checkout");
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(repositoryRoot),
    canonicalPotentialPath(path),
  ]);
  if (isWithin(canonicalPath, canonicalRoot)) throw new Error("Workspace root resolves inside the public checkout");
  return canonicalPath;
}
