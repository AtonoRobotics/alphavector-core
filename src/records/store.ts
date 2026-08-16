import { chmodSync } from "node:fs";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { TenantRecord, TenantRecordStore } from "./types.js";

/**
 * Load the tenant record file. Missing file → empty store (no invented record).
 * Corrupt or incomplete JSON → refuse. Do not reconstruct a record from guesswork.
 */
export function loadRecordStore(file: string): TenantRecordStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("RECORD_STORE_CORRUPT", "Record store is corrupt; refusing to invent a record");
  }
  if (raw === undefined) return { records: [] };
  return parseStore(raw);
}

export function saveRecordStore(file: string, store: TenantRecordStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

function parseStore(raw: unknown): TenantRecordStore {
  if (!isRecord(raw) || !Array.isArray(raw.records)) {
    throw new AvError("RECORD_STORE_CORRUPT", "Record store is corrupt; refusing to invent a record");
  }
  return { records: raw.records.map(parseRecord) };
}

function parseRecord(raw: unknown): TenantRecord {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.type !== "string" ||
    !raw.type ||
    typeof raw.label !== "string" ||
    !raw.label
  ) {
    throw new AvError("RECORD_STORE_CORRUPT", "Record store is corrupt; refusing to invent a record");
  }
  return { id: raw.id, type: raw.type, label: raw.label };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
