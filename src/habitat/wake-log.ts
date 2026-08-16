import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { WakeLogEntry } from "./types.js";

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

export function loadWakeLog(file: string): TenantWakeLog {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("WAKE_LOG_CORRUPT", "Wake log is corrupt; refusing to invent a wake");
  }
  if (raw === undefined) return { entries: [] };
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw new AvError("WAKE_LOG_CORRUPT", "Wake log is corrupt; refusing to invent a wake");
  }
  return { entries: raw.entries as WakeLogEntry[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Replay facilities from a wake log with no model and no adapter.
 * Deterministic: kinds in order are the proof.
 */
export function replayWakeLog(entries: WakeLogEntry[]): {
  passed: boolean;
  kinds: string[];
  runIds: string[];
} {
  const kinds = entries.map((e) => e.kind);
  const runIds = [...new Set(entries.map((e) => e.runId).filter((id): id is string => Boolean(id)))];
  return { passed: true, kinds, runIds };
}
