import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  deadlinesFile,
  findStoredDeadline,
  readTenantDeadlines,
  saveDeadlineStore,
  upsertDeadline,
  type DeadlineRecord,
} from "../habitat/deadline-store.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/deadlines.json (DEC-020).
 * Same class as routines / mail / adapter-bind. Shell is not Architect.
 * Field SHALL NOT author, see, or edit. Not a /field route. Not Temporal.
 */
export function architectWriteDeadline(input: {
  tenantId: string;
  deadlineId: string;
  dueAt: string;
  computerBaseDir: string;
  architectToken?: string;
}): DeadlineRecord {
  const deadlineId = input.deadlineId.trim();
  const dueAt = input.dueAt.trim();
  if (!deadlineId) {
    throw new AvError("DEADLINE_ID_REQUIRED", "Architect deadline write requires a deadline id");
  }
  if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
    throw new AvError("DEADLINE_DUE_REQUIRED", "Architect deadline write requires a dueAt timestamp");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const file = deadlinesFile(input.computerBaseDir, input.tenantId);
  const current = readTenantDeadlines(input.computerBaseDir, input.tenantId);
  const existing = findStoredDeadline(current, input.tenantId, deadlineId);
  const record: DeadlineRecord = {
    deadlineId,
    tenantId: input.tenantId,
    dueAt,
    boundBy: "architect",
    boundAt: existing?.boundAt ?? nowIso(),
    ...(existing?.lastFiredAt ? { lastFiredAt: existing.lastFiredAt } : {}),
  };
  saveDeadlineStore(file, upsertDeadline(current, record));
  return record;
}
