import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import { loadRunStore } from "./run-store.js";
import { stem, type StemDecision } from "./stem.js";
import { WAKE_KINDS, type WakeEvent, type WakeKind, type WakeLogEntry } from "./types.js";

export interface TenantWakeLog {
  entries: WakeLogEntry[];
}

export class WakeLog {
  private readonly logs = new Map<string, WakeLogEntry[]>();
  private readonly hydrated = new Set<string>();

  constructor(private readonly computerBaseDir?: string) {}

  append(entry: Omit<WakeLogEntry, "seq">): WakeLogEntry {
    const entries = this.list(entry.tenantId);
    const next: WakeLogEntry = { ...entry, seq: entries.length + 1 };
    entries.push(next);
    this.logs.set(entry.tenantId, entries);
    this.persist(entry.tenantId);
    return next;
  }

  list(tenantId: string): WakeLogEntry[] {
    this.ensure(tenantId);
    return [...(this.logs.get(tenantId) ?? [])];
  }

  private ensure(tenantId: string): void {
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    const loaded = loadWakeLog(this.fileFor(tenantId));
    this.logs.set(tenantId, loaded.entries);
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    writeJsonAtomic(this.fileFor(tenantId), { entries: this.logs.get(tenantId) ?? [] });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).wakeLogFile;
  }
}

export function loadWakeLog(file: string, opts?: { required?: boolean }): TenantWakeLog {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("WAKE_LOG_CORRUPT", "Wake log is corrupt; refusing to invent a wake");
  }
  if (raw === undefined) {
    if (opts?.required) {
      throw new AvError("WAKE_LOG_MISSING", "Wake log is missing; refusing to invent a replay");
    }
    return { entries: [] };
  }
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw new AvError("WAKE_LOG_CORRUPT", "Wake log is corrupt; refusing to invent a wake");
  }
  return { entries: raw.entries as WakeLogEntry[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const KNOWN_WAKE_KINDS: ReadonlySet<WakeKind> = new Set(WAKE_KINDS);

export interface WakeLogReplayResult {
  passed: boolean;
  kinds: string[];
  runIds: string[];
  error?: string;
}

export interface WakeLogReplayContext {
  /** Stored run ids from runs.json (or the in-memory run record). */
  runs?: Array<{ runId: string }>;
}

/**
 * Replay facilities from a wake log with no model and no adapter.
 * Re-applies stem() per entry and compares to the stored StemDecision.
 * Missing, empty, unknown, or mismatched logs fail closed. Do not invent a decision.
 */
export function replayWakeLog(entries: unknown, context?: WakeLogReplayContext): WakeLogReplayResult {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { passed: false, kinds: [], runIds: [], error: "WAKE_LOG_EMPTY" };
  }

  const kinds: string[] = [];
  const runIds: string[] = [];
  const storedRunIds = context?.runs?.map((run) => run.runId);

  for (const raw of entries) {
    if (!isRecord(raw) || typeof raw.kind !== "string" || !KNOWN_WAKE_KINDS.has(raw.kind as WakeKind)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    const kind = raw.kind as WakeKind;
    if (typeof raw.tenantId !== "string" || !raw.tenantId) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    const runId = typeof raw.runId === "string" && raw.runId ? raw.runId : undefined;
    const stored = raw.decision;
    if (!isStemDecision(stored)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    // Facilities only. Re-apply stem() and compare; no adapter, no model.
    const recomputed = stem(stemEventFromEntry(kind, raw.tenantId, runId, raw.detail));
    if (!stemDecisionsEqual(recomputed, stored)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    if (
      (kind === "field_ask" ||
        kind === "field_continue" ||
        kind === "routine" ||
        kind === "mail" ||
        kind === "deadline" ||
        kind === "architect_message") &&
      !runId
    ) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    if (runId && storedRunIds && !storedRunIds.includes(runId)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    kinds.push(kind);
    if (runId && !runIds.includes(runId)) runIds.push(runId);
  }

  return { passed: kinds.length > 0, kinds, runIds };
}

function isStemDecision(value: unknown): value is StemDecision {
  return (
    isRecord(value) &&
    typeof value.wakeOrchestrator === "boolean" &&
    typeof value.wakeOps === "boolean"
  );
}

function stemDecisionsEqual(a: StemDecision, b: StemDecision): boolean {
  return a.wakeOrchestrator === b.wakeOrchestrator && a.wakeOps === b.wakeOps;
}

function stemEventFromEntry(
  kind: WakeKind,
  tenantId: string,
  runId: string | undefined,
  detail: unknown,
): WakeEvent {
  const card =
    isRecord(detail) && (detail.decision === "approved" || detail.decision === "denied")
      ? detail.decision
      : undefined;
  return { kind, tenantId, runId, decision: card };
}

/** Load wake-log.json (and runs.json when present) from tenant disk, then replay. No model. */
export function replayWakeLogFromDisk(computerBaseDir: string, tenantId: string): WakeLogReplayResult {
  const paths = computerRoot(computerBaseDir, tenantId);
  const loaded = loadWakeLog(paths.wakeLogFile, { required: true });
  let runs: Array<{ runId: string }> = [];
  try {
    runs = loadRunStore(paths.runsFile).runs;
  } catch {
    runs = [];
  }
  return replayWakeLog(loaded.entries, { runs });
}
