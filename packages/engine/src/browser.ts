import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, type Locator, type Page } from "@playwright/test";
import type { Candidate, LocatorSpec } from "../../core/src/index.js";
import type { ActionSite } from "./patch.js";

export const ACTION_TIMEOUT_MS = 650;
const assertionExpect = expect.configure({ timeout: ACTION_TIMEOUT_MS });

export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  const scope = spec.scope ? page.getByRole("group", { name: spec.scope, exact: true }) : page;
  return spec.kind === "role"
    ? scope.getByRole(spec.role, { name: spec.name, exact: true })
    : scope.getByLabel(spec.label, { exact: true });
}

export interface TestExecution {
  passed: boolean;
  failureLine: number | null;
  failureColumn: number | null;
  error?: string;
}

/** Runs the authored test source unchanged; test/expect/page are the harness bindings. */
export async function executeTest(page: Page, filename: string, baseURL: string): Promise<TestExecution> {
  const source = await readFile(filename, "utf8");
  const registered: Array<(fixtures: { page: Page }) => Promise<void>> = [];
  const context = vm.createContext({
    baseURL,
    expect: assertionExpect,
    test: (_name: string, callback: (fixtures: { page: Page }) => Promise<void>) => registered.push(callback),
  });
  // This is a constrained self-authored test harness, NOT a security sandbox.
  new vm.Script(source, { filename }).runInContext(context, { timeout: 1000 });
  if (registered.length !== 1 || !registered[0]) throw new Error("Exactly one authored test must register");
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(5000);
  try {
    await registered[0]({ page });
    return { passed: true, failureLine: null, failureColumn: null };
  } catch (error) {
    const stack = error instanceof Error ? error.stack ?? error.message : String(error);
    // Inspect the actual failing source location, not merely the presence of an assertion.
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const location = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack);
    return {
      passed: false, failureLine: location?.[1] ? Number(location[1]) : null,
      failureColumn: location?.[2] ? Number(location[2]) : null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isActionFailure(execution: TestExecution, site: ActionSite): boolean {
  if (execution.passed || execution.failureLine === null || execution.failureColumn === null) return false;
  const { failureLine: line, failureColumn: column } = execution;
  return (line > site.startLine || (line === site.startLine && column >= site.startColumn))
    && (line < site.endLine || (line === site.endLine && column < site.endColumn));
}

export async function staticSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const copy = document.documentElement.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("script,iframe,object,embed,link,base,meta[http-equiv],form").forEach((node) => node.remove());
    copy.querySelectorAll("*").forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name) || ["src", "srcdoc", "href", "action", "formaction", "data-key"].includes(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    return `<!doctype html>${copy.outerHTML}`;
  });
}

interface ControlInfo {
  group: string | null;
  labels: string[];
  context: string;
}

async function controlInfo(locator: Locator): Promise<ControlInfo> {
  return locator.evaluate((element) => {
    const group = element.closest("fieldset,[role=group]");
    const section = element.closest(".control");
    const labelledBy = group?.getAttribute("aria-labelledby");
    const groupName = (labelledBy
      ? labelledBy.split(/\s+/).map((id) => (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").trim()).join(" ")
      : group?.getAttribute("aria-label") ?? group?.querySelector(":scope > legend")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? Array.from(element.labels ?? []).map((label) => (label.textContent ?? "").replace(/\s+/g, " ").trim()) : [];
    return {
      group: groupName || null,
      labels,
      context: [groupName, (section?.textContent ?? "").replace(/\s+/g, " ").trim()].filter(Boolean).join(" — "),
    };
  });
}

export async function oldContextFor(page: Page, spec: LocatorSpec): Promise<string> {
  const locator = resolveLocator(page, spec);
  if (await locator.count() !== 1) throw new Error("The original locator must uniquely resolve on the baseline page");
  return (await controlInfo(locator)).context;
}

function accessibleName(snapshot: string, role: string): string {
  const firstLine = snapshot.split("\n")[0] ?? "";
  const match = new RegExp(`^- ${role} "((?:[^"\\\\]|\\\\.)*)"`).exec(firstLine);
  if (!match?.[1]) return "";
  return JSON.parse(`"${match[1]}"`) as string;
}

export async function enumerateCandidates(page: Page, caseId: string, site: ActionSite): Promise<Candidate[]> {
  const role = site.operation === "click" ? "button" : "textbox";
  const controls = page.getByRole(role);
  const byLocator = new Map<string, Omit<Candidate, "id">>();
  for (const control of await controls.all()) {
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    const name = accessibleName(await control.ariaSnapshot(), role);
    if (!name) continue;
    const info = await controlInfo(control);
    const label = info.labels[0];
    const spec: LocatorSpec = site.locator.kind === "label" && label
      ? { kind: "label", label, ...(info.group ? { scope: info.group } : {}) }
      : { kind: "role", role, name, ...(info.group ? { scope: info.group } : {}) };
    const key = JSON.stringify(spec);
    const count = await resolveLocator(page, spec).count();
    const context = `${info.context}${info.labels.length ? `; labels: ${info.labels.join(", ")}` : ""}${count !== 1 ? `; matches ${count} controls (not unique)` : ""}`;
    byLocator.set(key, { locator: spec, context });
  }
  const sorted = [...byLocator.values()].map((candidate) => ({
    candidate,
    hash: createHash("sha256").update(`${caseId}\n${JSON.stringify(candidate)}`).digest("hex"),
  })).sort((left, right) => left.hash.localeCompare(right.hash));
  return sorted.map(({ candidate }, index) => ({ id: `c${index + 1}`, ...candidate }));
}

export async function candidateKeys(page: Page, candidate: Candidate): Promise<string[]> {
  return resolveLocator(page, candidate.locator).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-key") ?? ""),
  );
}
