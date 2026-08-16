import { chmodSync } from "node:fs";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { RecordUpdatePatch, TenantRecord, TenantRecordStore } from "./types.js";

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

/**
 * String-key / string-value map. Missing → empty (do not invent keys).
 * Incomplete rows (non-object, empty key, non-string value) fail closed.
 */
export function parseRecordAttributes(
  raw: unknown,
  code = "RECORD_STORE_CORRUPT",
): Record<string, string> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new AvError(code, "Record attributes are incomplete; refusing to invent a key");
  }
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof value !== "string") {
      throw new AvError(code, "Record attributes are incomplete; refusing to invent a key");
    }
    attributes[key] = value;
  }
  return attributes;
}

export function encodeRecordUpdatePatch(patch: RecordUpdatePatch): string {
  return JSON.stringify(patch);
}

export function decodeRecordUpdatePatch(raw: string): RecordUpdatePatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AvError("RECORD_ATTRIBUTES_INVALID", "Record update is incomplete; refusing to invent a key");
  }
  if (!isRecord(parsed)) {
    throw new AvError("RECORD_ATTRIBUTES_INVALID", "Record update is incomplete; refusing to invent a key");
  }
  const patch: RecordUpdatePatch = {};
  if (parsed.type !== undefined) {
    if (typeof parsed.type !== "string" || !parsed.type) {
      throw new AvError("RECORD_ATTRIBUTES_INVALID", "Record update is incomplete; refusing to invent a key");
    }
    patch.type = parsed.type;
  }
  if (parsed.label !== undefined) {
    if (typeof parsed.label !== "string" || !parsed.label) {
      throw new AvError("RECORD_ATTRIBUTES_INVALID", "Record update is incomplete; refusing to invent a key");
    }
    patch.label = parsed.label;
  }
  if (parsed.attributes !== undefined) {
    patch.attributes = parseRecordAttributes(parsed.attributes, "RECORD_ATTRIBUTES_INVALID");
  }
  return patch;
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
  return {
    id: raw.id,
    type: raw.type,
    label: raw.label,
    attributes: parseRecordAttributes(raw.attributes),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
