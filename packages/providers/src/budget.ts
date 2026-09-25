import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProviderId, Usage } from "../../core/src/index.js";
import { integer, object, ProviderError, text } from "./errors.js";

const NANOS = 1_000_000_000;
export const MAX_BUDGET_USD = 10;

export interface Reservation {
  id: string;
  provider: Exclude<ProviderId, "rule">;
  maximumNanos: number;
  status: "reserved" | "unknown" | "settled";
  createdAt: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  actualNanos?: number;
  usage?: Usage;
  failureCode?: string;
  reconciliation?: { evidence: string; at: string };
  continuation?: { terminalEvidence: string; authorizedAt: string; maxCalls: number };
}

export interface BudgetSnapshot {
  schemaVersion: 1;
  capNanos: number;
  reservations: Reservation[];
}

export function usdToNanos(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(Math.ceil(usd * NANOS))) {
    throw new ProviderError("INVALID_COST", "Cost is not a finite nonnegative representable USD amount");
  }
  return Math.ceil(usd * NANOS);
}

export function committedNanos(snapshot: BudgetSnapshot): number {
  const total = snapshot.reservations.reduce(
    (sum, entry) => sum + (entry.status === "settled" ? entry.actualNanos! : entry.maximumNanos), 0,
  );
  return integer(total, "ledger total");
}

export function blocksReservation(entry: Reservation, callCount: number): boolean {
  return entry.status !== "settled" && !(entry.status === "unknown" &&
    entry.continuation !== undefined && callCount < entry.continuation.maxCalls);
}

function parseSnapshot(value: unknown): BudgetSnapshot {
  const data = object(value, "ledger");
  if (data.schemaVersion !== 1 || !Array.isArray(data.reservations)) {
    throw new ProviderError("INVALID_LEDGER", "Unsupported or malformed budget ledger");
  }
  const capNanos = integer(data.capNanos, "capNanos", 1, MAX_BUDGET_USD * NANOS);
  const ids = new Set<string>();
  const reservations = data.reservations.map((raw): Reservation => {
    const entry = object(raw, "reservation");
    const id = text(entry.id, "reservation ID");
    if (ids.has(id)) throw new ProviderError("INVALID_LEDGER", "Duplicate reservation");
    ids.add(id);
    if (entry.provider !== "azure" && entry.provider !== "jev") {
      throw new ProviderError("INVALID_LEDGER", "Unknown ledger provider");
    }
    if (!["reserved", "unknown", "settled"].includes(String(entry.status))) {
      throw new ProviderError("INVALID_LEDGER", "Unknown reservation status");
    }
    const result: Reservation = {
      id,
      provider: entry.provider,
      maximumNanos: integer(entry.maximumNanos, "maximumNanos"),
      status: entry.status as Reservation["status"],
      createdAt: text(entry.createdAt, "createdAt"),
      inputTokenLimit: integer(entry.inputTokenLimit, "inputTokenLimit", 1),
      outputTokenLimit: integer(entry.outputTokenLimit, "outputTokenLimit"),
    };
    if (entry.status === "settled") result.actualNanos = integer(entry.actualNanos, "actualNanos");
    if (entry.failureCode !== undefined) result.failureCode = text(entry.failureCode, "failureCode");
    if (entry.usage !== undefined) result.usage = validateUsage(entry.usage);
    if (entry.reconciliation !== undefined) {
      const reconciliation = object(entry.reconciliation, "reconciliation");
      result.reconciliation = {
        evidence: text(reconciliation.evidence, "reconciliation evidence"),
        at: text(reconciliation.at, "reconciliation date"),
      };
    }
    if (entry.continuation !== undefined) {
      const continuation = object(entry.continuation, "continuation");
      if (!["unknown", "settled"].includes(result.status) ||
          !["AUTHENTICATION", "PERMISSION"].includes(result.failureCode ?? "")) {
        throw new ProviderError("INVALID_LEDGER", "Only terminal authentication rejections may retain a continuation authorization");
      }
      result.continuation = {
        terminalEvidence: text(continuation.terminalEvidence, "terminal rejection evidence"),
        authorizedAt: text(continuation.authorizedAt, "continuation authorization date"),
        maxCalls: integer(continuation.maxCalls, "continuation maxCalls", 1, 1000),
      };
    }
    return result;
  });
  const snapshot: BudgetSnapshot = { schemaVersion: 1, capNanos, reservations };
  committedNanos(snapshot);
  return snapshot;
}

export function validateUsage(value: unknown): Usage {
  const usage = object(value, "usage");
  const result: Usage = {
    inputTokens: integer(usage.inputTokens, "inputTokens"),
    outputTokens: integer(usage.outputTokens, "outputTokens"),
  };
  if (usage.reasoningTokens !== undefined) {
    result.reasoningTokens = integer(usage.reasoningTokens, "reasoningTokens", 0, result.outputTokens);
  }
  if (usage.cachedInputTokens !== undefined) {
    result.cachedInputTokens = integer(usage.cachedInputTokens, "cachedInputTokens", 0, result.inputTokens);
  }
  return result;
}

export class BudgetLedger {
  readonly path: string;
  readonly capNanos: number;

  constructor(path: string, capUsd = MAX_BUDGET_USD) {
    this.path = resolve(path);
    this.capNanos = usdToNanos(capUsd);
    integer(this.capNanos, "budget cap", 1, MAX_BUDGET_USD * NANOS);
  }

  /** Explicit, once-only initialization; missing ledgers never silently reset spending. */
  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.locked(async () => {
      const file = await open(this.path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, capNanos: this.capNanos, reservations: [] }));
        await file.sync();
      } finally {
        await file.close();
      }
    });
  }

  async inspect(): Promise<BudgetSnapshot> {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch {
      throw new ProviderError("LEDGER_UNREADABLE", "Budget ledger missing or unreadable; do not recreate a previously used ledger");
    }
    const snapshot = parseSnapshot(data);
    if (snapshot.capNanos !== this.capNanos) {
      throw new ProviderError("BUDGET_MISMATCH", "Configured budget differs from the durable ledger cap");
    }
    return snapshot;
  }

  async reserve(
    provider: Reservation["provider"], maximumUsd: number, inputTokenLimit: number, outputTokenLimit: number,
    maxCalls = 1000,
  ): Promise<Reservation> {
    const maximumNanos = usdToNanos(maximumUsd);
    integer(inputTokenLimit, "inputTokenLimit", 1);
    integer(outputTokenLimit, "outputTokenLimit");
    integer(maxCalls, "maxCalls", 1, 1000);
    return this.locked(async () => {
      const snapshot = await this.inspect();
      if (snapshot.reservations.length >= maxCalls) throw new ProviderError("CALL_LIMIT", "Shared call limit reached");
      if (snapshot.reservations.some((entry) => blocksReservation(entry, snapshot.reservations.length))) {
        throw new ProviderError("UNRESOLVED_BILLING", "A pending/unknown reservation blocks all providers until explicit reconciliation");
      }
      if (committedNanos(snapshot) + maximumNanos > snapshot.capNanos) {
        throw new ProviderError("BUDGET_EXCEEDED", "The next maximum reservation exceeds the shared budget");
      }
      const entry: Reservation = {
        id: randomUUID(), provider, maximumNanos, inputTokenLimit, outputTokenLimit,
        status: "reserved", createdAt: new Date().toISOString(),
      };
      snapshot.reservations.push(entry);
      await this.persist(snapshot);
      return entry;
    });
  }

  async settle(id: string, actualUsd: number, usage: Usage): Promise<void> {
    const actualNanos = usdToNanos(actualUsd);
    const checked = validateUsage(usage);
    await this.update(id, (entry) => {
      if (entry.status !== "reserved") throw new ProviderError("INVALID_TRANSITION", "Only an active reservation can settle");
      if (actualNanos > entry.maximumNanos || checked.inputTokens > entry.inputTokenLimit ||
          checked.outputTokens > entry.outputTokenLimit) {
        throw new ProviderError("BOUND_EXCEEDED", "Usage or cost exceeded its reserved maximum", id);
      }
      entry.status = "settled";
      entry.actualNanos = actualNanos;
      entry.usage = checked;
    });
  }

  async markUnknown(id: string, failureCode: string): Promise<void> {
    await this.update(id, (entry) => {
      if (entry.status === "settled") throw new ProviderError("INVALID_TRANSITION", "A settled reservation cannot become unknown");
      entry.status = "unknown";
      entry.failureCode = text(failureCode, "failureCode");
      delete entry.continuation;
    });
  }

  /** Explicit user authorization after verifying a terminal rejection; this never settles or releases its cost. */
  async authorizeOneAdditionalCall(id: string, terminalEvidence: string): Promise<void> {
    await this.authorizeAdditionalCalls(id, 1, terminalEvidence);
  }

  async authorizeAdditionalCalls(id: string, additionalCalls: number, terminalEvidence: string): Promise<void> {
    integer(additionalCalls, "authorized additional calls", 1, 1000);
    text(terminalEvidence, "terminal rejection evidence and user authorization");
    await this.locked(async () => {
      const snapshot = await this.inspect();
      const pending = snapshot.reservations.filter((entry) => entry.status !== "settled");
      const entry = pending[0];
      if (pending.length !== 1 || entry?.id !== id || entry.status !== "unknown" ||
          !["AUTHENTICATION", "PERMISSION"].includes(entry.failureCode ?? "")) {
        throw new ProviderError("INVALID_TRANSITION", "Only one externally verified terminal authentication rejection may be carried forward");
      }
      entry.continuation = {
        terminalEvidence, authorizedAt: new Date().toISOString(),
        maxCalls: integer(snapshot.reservations.length + additionalCalls, "continuation maxCalls", 1, 1000),
      };
      await this.persist(snapshot);
    });
  }

  /** Call only after externally verifying both final billing and request termination. */
  async reconcile(id: string, actualUsd: number, evidence: string): Promise<void> {
    const actualNanos = usdToNanos(actualUsd);
    text(evidence, "evidence");
    await this.update(id, (entry) => {
      if (entry.status === "settled") throw new ProviderError("INVALID_TRANSITION", "Already settled");
      entry.status = "settled";
      entry.actualNanos = actualNanos;
      entry.reconciliation = { evidence, at: new Date().toISOString() };
    });
  }

  private async update(id: string, action: (entry: Reservation) => void): Promise<void> {
    await this.locked(async () => {
      const snapshot = await this.inspect();
      const entry = snapshot.reservations.find((reservation) => reservation.id === id);
      if (!entry) throw new ProviderError("UNKNOWN_RESERVATION", "Reservation not found");
      action(entry);
      await this.persist(snapshot);
    });
  }

  private async persist(snapshot: BudgetSnapshot): Promise<void> {
    const staging = `${this.path}.${randomUUID()}.new`;
    const file = await open(staging, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(snapshot, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(staging, this.path);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      throw error;
    }
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      throw new ProviderError("LEDGER_LOCKED", "Budget lock unavailable; never automatically steal or expire it");
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await lock.sync();
      return await action();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
