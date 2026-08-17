import { createHash } from "node:crypto";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { canonicalJson, nowIso } from "../ids.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import { loadRunStore } from "./run-store.js";
import { stem, type StemDecision } from "./stem.js";
import { WAKE_KINDS, type WakeEvent, type WakeKind, type WakeLogEntry } from "./types.js";

export interface TenantWakeLog {
  entries: WakeLogEntry[];
}

/** Wake payload hashed into payloadHash. Stem decision is not part of this. */
export interface WakePayload {
  kind: string;
  time: string;
  tenant: string;
  run: string;
  target: string;
  detail?: Record<string, unknown>;
}

export function hashWakePayload(payload: WakePayload): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        kind: payload.kind,
        time: payload.time,
        tenant: payload.tenant,
        run: payload.run,
        target: payload.target,
        ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Who the wake is aimed at. Not a WakeKind.
 * addressee → that agent; worker_done / worker_failed / held coder → worker;
 * wakeOps → ops; wakeOrchestrator → orchestrator.
 */
export function wakeTarget(event: WakeEvent, decision: StemDecision): string {
  const addressee = event.addresseeId?.trim();
  if (addressee) return addressee;
  if (event.kind === "worker_done" || event.kind === "worker_failed") {
    return event.workerId?.trim() || "worker";
  }
  if (decision.wakeOps) return "ops";
  if (decision.wakeOrchestrator) return "orchestrator";
  return "orchestrator";
}

export function recordWake(input: {
  kind: WakeKind;
  tenantId: string;
  run: string;
  target: string;
  decision: StemDecision;
  detail?: Record<string, unknown>;
  time?: string;
}): Omit<WakeLogEntry, "seq"> {
  const run = input.run.trim();
  const tenant = input.tenantId.trim();
  const target = input.target.trim();
  const time = input.time ?? nowIso();
  if (!run || !tenant || !target || !time) {
    throw new AvError("WAKE_LOG_MISMATCH", "Wake log requires kind, time, tenant, run, target; refusing to invent a wake");
  }
  const payloadHash = hashWakePayload({
    kind: input.kind,
    time,
    tenant,
    run,
    target,
    detail: input.detail,
  });
  return {
    kind: input.kind,
    time,
    tenant,
    run,
    target,
    payloadHash,
    tenantId: tenant,
    runId: run,
    at: time,
    decision: input.decision,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

function sealEntry(entry: WakeLogEntry): WakeLogEntry {
  if (entry.detail) Object.freeze(entry.detail);
  Object.freeze(entry.decision);
  return Object.freeze(entry);
}

export class WakeLog {
  private readonly logs = new Map<string, WakeLogEntry[]>();
  private readonly hydrated = new Set<string>();

  constructor(private readonly computerBaseDir?: string) {}

  append(entry: Omit<WakeLogEntry, "seq">): WakeLogEntry {
    const tenantKey = entry.tenant || entry.tenantId;
    const prior = this.list(tenantKey);
    const next = sealEntry({ ...entry, seq: prior.length + 1 });
    const integrity = wakeLogEntryError(next, next.seq);
    if (integrity) {
      throw new AvError(integrity, "Wake log refused an incomplete or mutated record");
    }
    this.logs.set(tenantKey, [...prior, next]);
    this.persist(tenantKey);
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
    this.logs.set(tenantId, loaded.entries.map((entry, i) => sealEntry({ ...entry, seq: entry.seq ?? i + 1 })));
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    writeJsonAtomic(this.fileFor(tenantId), { entries: this.logs.get(tenantId) ?? [] });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).wakeLogFile;
  }
}

export function loadWakeLog(
  file: string,
  opts?: { required?: boolean; verify?: boolean },
): TenantWakeLog {
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
  if (opts?.verify !== false) {
    const integrity = wakeLogIntegrityError(raw.entries);
    if (integrity) {
      throw new AvError(integrity, "Wake log failed closed; refusing to invent a wake");
    }
  }
  return { entries: raw.entries as WakeLogEntry[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Replay admits only typed kinds. Unknown kind is WAKE_LOG_MISMATCH.
 * HK-011: architect_message and worker_failed belong here. Do not invent a kind.
 */
const KNOWN_WAKE_KINDS: ReadonlySet<WakeKind> = new Set([
  "field_start",
  "field_ask",
  "field_continue",
  "card_decide",
  "worker_done",
  "worker_failed",
  "kill",
  "deadline",
  "connector",
  "routine",
  "mail",
  "architect_message",
]);

for (const kind of WAKE_KINDS) {
  if (!KNOWN_WAKE_KINDS.has(kind)) {
    throw new AvError("WAKE_LOG_MISMATCH", "Wake-log kinds must cover the closed WakeKind set");
  }
}

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

export function wakeLogIntegrityError(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return "WAKE_LOG_MISMATCH";
  for (let i = 0; i < entries.length; i++) {
    const err = wakeLogEntryError(entries[i], i + 1);
    if (err) return err;
  }
  return undefined;
}

function wakeLogEntryError(raw: unknown, expectedSeq: number): string | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string" || !KNOWN_WAKE_KINDS.has(raw.kind as WakeKind)) {
    return "WAKE_LOG_MISMATCH";
  }
  if (raw.seq !== expectedSeq) return "WAKE_LOG_MISMATCH";
  if (typeof raw.time !== "string" || !raw.time) return "WAKE_LOG_MISMATCH";
  if (typeof raw.tenant !== "string" || !raw.tenant) return "WAKE_LOG_MISMATCH";
  if (typeof raw.run !== "string" || !raw.run) return "WAKE_LOG_MISMATCH";
  if (typeof raw.target !== "string" || !raw.target) return "WAKE_LOG_MISMATCH";
  if (typeof raw.payloadHash !== "string" || !raw.payloadHash) return "WAKE_LOG_MISMATCH";
  if (raw.detail !== undefined && !isRecord(raw.detail)) return "WAKE_LOG_MISMATCH";
  const recomputed = hashWakePayload({
    kind: raw.kind,
    time: raw.time,
    tenant: raw.tenant,
    run: raw.run,
    target: raw.target,
    detail: raw.detail !== undefined ? (raw.detail as Record<string, unknown>) : undefined,
  });
  if (recomputed !== raw.payloadHash) return "WAKE_LOG_MISMATCH";
  return undefined;
}

/**
 * Replay facilities from a wake log with no model and no adapter.
 * Re-applies stem() per entry and compares to the stored StemDecision.
 * Missing, empty, unknown, or mismatched logs fail closed. Do not invent a decision.
 * HK-014: also fail closed on missing required fields, mutated payloadHash, or edited prior seq.
 */
export function replayWakeLog(entries: unknown, context?: WakeLogReplayContext): WakeLogReplayResult {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { passed: false, kinds: [], runIds: [], error: "WAKE_LOG_EMPTY" };
  }

  const kinds: string[] = [];
  const runIds: string[] = [];
  const storedRunIds = context?.runs?.map((run) => run.runId);

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    if (wakeLogEntryError(raw, i + 1)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    if (!isRecord(raw) || typeof raw.kind !== "string" || !KNOWN_WAKE_KINDS.has(raw.kind as WakeKind)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    const kind = raw.kind as WakeKind;
    const tenant =
      typeof raw.tenant === "string" && raw.tenant
        ? raw.tenant
        : typeof raw.tenantId === "string" && raw.tenantId
          ? raw.tenantId
          : "";
    if (!tenant) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    const runId =
      typeof raw.run === "string" && raw.run
        ? raw.run
        : typeof raw.runId === "string" && raw.runId
          ? raw.runId
          : "";
    if (!runId) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    const stored = raw.decision;
    if (!isStemDecision(stored)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    // Facilities only. Re-apply stem() and compare; no adapter, no model.
    const recomputed = stem(stemEventFromEntry(kind, tenant, runId, raw.detail));
    if (!stemDecisionsEqual(recomputed, stored)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    if (storedRunIds && !storedRunIds.includes(runId)) {
      return { passed: false, kinds, runIds, error: "WAKE_LOG_MISMATCH" };
    }
    kinds.push(kind);
    if (!runIds.includes(runId)) runIds.push(runId);
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
  runId: string,
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
  const loaded = loadWakeLog(paths.wakeLogFile, { required: true, verify: false });
  let runs: Array<{ runId: string }> = [];
  try {
    runs = loadRunStore(paths.runsFile).runs;
  } catch {
    runs = [];
  }
  return replayWakeLog(loaded.entries, { runs });
}
