import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

export type RoutineBoundBy = "architect" | "pack";

/**
 * Architect- or pack-written routine on the tenant computer (CS-013).
 * Same class as adapter-bind: core-owned, beside disk/, never a field file.
 * Pack declaration is not live until stored here.
 */
export interface RoutineRecord {
  routineId: string;
  tenantId: string;
  goal: string;
  dueAt: string;
  boundBy: RoutineBoundBy;
  boundAt: string;
  lastFiredAt?: string;
  journeyId?: string;
  recordId?: string;
}

export interface TenantRoutineStore {
  routines: RoutineRecord[];
}

/**
 * Load tenants/{id}/routines.json. Missing file → empty (no invent).
 * Corrupt or incomplete JSON → refuse. Do not invent routines.
 */
export function loadRoutineStore(file: string, opts?: { required?: boolean }): TenantRoutineStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("ROUTINE_STORE_CORRUPT", "Routine store is corrupt; refusing to invent a routine");
  }
  if (raw === undefined) {
    if (opts?.required) {
      throw new AvError("ROUTINE_STORE_MISSING", "Routine store is missing; refusing to invent a routine");
    }
    return { routines: [] };
  }
  return parseStore(raw);
}

export function saveRoutineStore(file: string, store: TenantRoutineStore): void {
  writeJsonAtomic(file, store);
}

export function routinesFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).routinesFile;
}

export function readTenantRoutines(
  computerBaseDir: string | undefined,
  tenantId: string,
  opts?: { required?: boolean },
): TenantRoutineStore {
  if (!computerBaseDir) {
    if (opts?.required) {
      throw new AvError("ROUTINE_STORE_MISSING", "Routine store is missing; refusing to invent a routine");
    }
    return { routines: [] };
  }
  return loadRoutineStore(routinesFile(computerBaseDir, tenantId), opts);
}

export function findStoredRoutine(
  store: TenantRoutineStore,
  tenantId: string,
  routineId: string,
): RoutineRecord | undefined {
  return store.routines.find((row) => row.routineId === routineId && row.tenantId === tenantId);
}

export function upsertRoutine(store: TenantRoutineStore, record: RoutineRecord): TenantRoutineStore {
  const next = store.routines.filter(
    (row) => !(row.routineId === record.routineId && row.tenantId === record.tenantId),
  );
  next.push(record);
  return { routines: next };
}

export function isRoutineDue(record: RoutineRecord, now: string): boolean {
  const due = Date.parse(record.dueAt);
  const at = Date.parse(now);
  if (!Number.isFinite(due) || !Number.isFinite(at) || due > at) return false;
  if (!record.lastFiredAt) return true;
  const fired = Date.parse(record.lastFiredAt);
  if (!Number.isFinite(fired)) return false;
  return due > fired;
}

function parseStore(raw: unknown): TenantRoutineStore {
  if (!isRecord(raw) || !Array.isArray(raw.routines)) {
    throw new AvError("ROUTINE_STORE_CORRUPT", "Routine store is corrupt; refusing to invent a routine");
  }
  return { routines: raw.routines.map(parseRoutine) };
}

function parseRoutine(raw: unknown): RoutineRecord {
  if (
    !isRecord(raw) ||
    typeof raw.routineId !== "string" ||
    !raw.routineId.trim() ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.goal !== "string" ||
    !raw.goal.trim() ||
    typeof raw.dueAt !== "string" ||
    !raw.dueAt ||
    (raw.boundBy !== "architect" && raw.boundBy !== "pack") ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt
  ) {
    throw new AvError("ROUTINE_STORE_CORRUPT", "Routine store is corrupt; refusing to invent a routine");
  }
  const record: RoutineRecord = {
    routineId: raw.routineId.trim(),
    tenantId: raw.tenantId,
    goal: raw.goal.trim(),
    dueAt: raw.dueAt,
    boundBy: raw.boundBy,
    boundAt: raw.boundAt,
  };
  if (typeof raw.lastFiredAt === "string" && raw.lastFiredAt) record.lastFiredAt = raw.lastFiredAt;
  if (typeof raw.journeyId === "string" && raw.journeyId) record.journeyId = raw.journeyId;
  if (typeof raw.recordId === "string" && raw.recordId) record.recordId = raw.recordId;
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
