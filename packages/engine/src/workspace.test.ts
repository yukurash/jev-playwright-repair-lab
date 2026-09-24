import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultWorkspaceRoot, privateWorkspaceRoot, repositoryRoot } from "./workspace.js";

describe("private workspace boundary", () => {
  it("derives the sibling default from the engine module, not the invocation directory", async () => {
    expect(defaultWorkspaceRoot).toBe(resolve(repositoryRoot, "..", "jev-playwright-repair-lab-private", "workspaces"));
    expect(await privateWorkspaceRoot()).toBe(defaultWorkspaceRoot);
  });

  it("rejects the public root, children, and normalized traversal before creating paths", async () => {
    await expect(privateWorkspaceRoot(repositoryRoot)).rejects.toThrow("outside the public checkout");
    await expect(privateWorkspaceRoot(join(repositoryRoot, ".repair-workspaces"))).rejects.toThrow("outside the public checkout");
    await expect(privateWorkspaceRoot(join(defaultWorkspaceRoot, "..", "..", "jev-playwright-repair-lab", "new", "child"))).rejects.toThrow("outside the public checkout");
  });

  it("rejects external junctions pointing back into the public checkout", async () => {
    const root = await privateWorkspaceRoot();
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, "boundary-test-"));
    try {
      const alias = join(workspace, "public-alias");
      await symlink(repositoryRoot, alias, "junction");
      await expect(privateWorkspaceRoot(join(alias, "not-created", "child"))).rejects.toThrow("resolves inside the public checkout");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
