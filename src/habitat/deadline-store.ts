import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

export type DeadlineBoundBy = "architect" | "habitat";

/**
 * Architect- or habitat-written deadline on the tenant computer.
 * Same class as routines / mail / adapter-bind: core-owned, beside disk/, never a field file.
 * Not Temporal. The habitat clock fires due rows.
 */
export interface DeadlineRecord {
  deadlineId: string;
  tenantId: string;
  dueAt: string;
  boundBy: DeadlineBoundBy;
  boundAt: string;
  lastFiredAt?: string;
}

export interface TenantDeadlineStore {
  deadlines: DeadlineRecord[];
}

/**
 * Load tenants/{id}/deadlines.json. Missing file → empty (no invent).
 * Corrupt or incomplete JSON → refuse. Do not invent deadlines.
 */
export function loadDeadlineStore(file: string, opts?: { required?: boolean }): TenantDeadlineStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("DEADLINE_STORE_CORRUPT", "Deadline store is corrupt; refusing to invent a deadline");
  }
  if (raw === undefined) {
    if (opts?.required) {
      throw new AvError("DEADLINE_STORE_MISSING", "Deadline store is missing; refusing to invent a deadline");
    }
    return { deadlines: [] };
  }
  return parseStore(raw);
}

export function saveDeadlineStore(file: string, store: TenantDeadlineStore): void {
  writeJsonAtomic(file, store);
}

export function deadlinesFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).deadlinesFile;
}

export function readTenantDeadlines(
  computerBaseDir: string | undefined,
  tenantId: string,
  opts?: { required?: boolean },
): TenantDeadlineStore {
  if (!computerBaseDir) {
    if (opts?.required) {
      throw new AvError("DEADLINE_STORE_MISSING", "Deadline store is missing; refusing to invent a deadline");
    }
    return { deadlines: [] };
  }
  return loadDeadlineStore(deadlinesFile(computerBaseDir, tenantId), opts);
}

export function findStoredDeadline(
  store: TenantDeadlineStore,
  tenantId: string,
  deadlineId: string,
): DeadlineRecord | undefined {
  return store.deadlines.find((row) => row.deadlineId === deadlineId && row.tenantId === tenantId);
}

export function upsertDeadline(store: TenantDeadlineStore, record: DeadlineRecord): TenantDeadlineStore {
  const next = store.deadlines.filter(
    (row) => !(row.deadlineId === record.deadlineId && row.tenantId === record.tenantId),
  );
  next.push(record);
  return { deadlines: next };
}

export function isDeadlineDue(record: DeadlineRecord, now: string): boolean {
  const due = Date.parse(record.dueAt);
  const at = Date.parse(now);
  if (!Number.isFinite(due) || !Number.isFinite(at) || due > at) return false;
  if (!record.lastFiredAt) return true;
  const fired = Date.parse(record.lastFiredAt);
  if (!Number.isFinite(fired)) return false;
  return due > fired;
}

function parseStore(raw: unknown): TenantDeadlineStore {
  if (!isRecord(raw) || !Array.isArray(raw.deadlines)) {
    throw new AvError("DEADLINE_STORE_CORRUPT", "Deadline store is corrupt; refusing to invent a deadline");
  }
  return { deadlines: raw.deadlines.map(parseDeadline) };
}

function parseDeadline(raw: unknown): DeadlineRecord {
  if (
    !isRecord(raw) ||
    typeof raw.deadlineId !== "string" ||
    !raw.deadlineId.trim() ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.dueAt !== "string" ||
    !raw.dueAt ||
    (raw.boundBy !== "architect" && raw.boundBy !== "habitat") ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt
  ) {
    throw new AvError("DEADLINE_STORE_CORRUPT", "Deadline store is corrupt; refusing to invent a deadline");
  }
  const record: DeadlineRecord = {
    deadlineId: raw.deadlineId.trim(),
    tenantId: raw.tenantId,
    dueAt: raw.dueAt,
    boundBy: raw.boundBy,
    boundAt: raw.boundAt,
  };
  if (typeof raw.lastFiredAt === "string" && raw.lastFiredAt) record.lastFiredAt = raw.lastFiredAt;
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
