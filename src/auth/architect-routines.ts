import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import type { LoadedPack } from "../packs/types.js";
import {
  findStoredRoutine,
  readTenantRoutines,
  routinesFile,
  saveRoutineStore,
  upsertRoutine,
  type RoutineRecord,
} from "../habitat/routine-store.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/routines.json (CS-013 / DEC-020).
 * Same class as adapter-bind / field-tokens. Shell is not Architect.
 * Field SHALL NOT author, see, or edit. Not a /field route. Not Temporal.
 * Pack declaration is not live until this write (or pack materialize) stores it.
 */
export function architectWriteRoutine(input: {
  tenantId: string;
  routineId: string;
  goal: string;
  dueAt: string;
  computerBaseDir: string;
  architectToken?: string;
  journeyId?: string;
  recordId?: string;
}): RoutineRecord {
  const routineId = input.routineId.trim();
  const goal = input.goal.trim();
  const dueAt = input.dueAt.trim();
  if (!routineId) {
    throw new AvError("ROUTINE_ID_REQUIRED", "Architect routine write requires a routine id");
  }
  if (!goal) {
    throw new AvError("GOAL_REQUIRED", "Architect routine write requires one goal");
  }
  if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
    throw new AvError("ROUTINE_DUE_REQUIRED", "Architect routine write requires a dueAt timestamp");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const file = routinesFile(input.computerBaseDir, input.tenantId);
  const current = readTenantRoutines(input.computerBaseDir, input.tenantId);
  const existing = findStoredRoutine(current, input.tenantId, routineId);
  const record: RoutineRecord = {
    routineId,
    tenantId: input.tenantId,
    goal,
    dueAt,
    boundBy: "architect",
    boundAt: existing?.boundAt ?? nowIso(),
    ...(existing?.lastFiredAt ? { lastFiredAt: existing.lastFiredAt } : {}),
    ...(input.journeyId ? { journeyId: input.journeyId } : {}),
    ...(input.recordId ? { recordId: input.recordId } : {}),
  };
  saveRoutineStore(file, upsertRoutine(current, record));
  return record;
}

/**
 * Materialize optional pack.routines onto the tenant computer.
 * Pack declaration is not a due wake until this write. Does not invent
 * routines when the pack omits the optional list.
 */
export function architectMaterializePackRoutines(input: {
  tenantId: string;
  pack: LoadedPack;
  computerBaseDir: string;
  architectToken?: string;
}): RoutineRecord[] {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const declared = input.pack.binding.routines ?? [];
  if (declared.length === 0) return [];
  const file = routinesFile(input.computerBaseDir, input.tenantId);
  let store = readTenantRoutines(input.computerBaseDir, input.tenantId);
  const written: RoutineRecord[] = [];
  const boundAt = nowIso();
  for (const decl of declared) {
    const existing = findStoredRoutine(store, input.tenantId, decl.id);
    const record: RoutineRecord = {
      routineId: decl.id,
      tenantId: input.tenantId,
      goal: decl.goal,
      dueAt: decl.dueAt ?? "9999-12-31T00:00:00.000Z",
      boundBy: "pack",
      boundAt: existing?.boundAt ?? boundAt,
      ...(existing?.lastFiredAt ? { lastFiredAt: existing.lastFiredAt } : {}),
    };
    store = upsertRoutine(store, record);
    written.push(record);
  }
  saveRoutineStore(file, store);
  return written;
}
