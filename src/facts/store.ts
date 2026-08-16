import { chmodSync } from "node:fs";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { TenantFact, TenantFactStore } from "./types.js";

/**
 * Load the tenant fact file. Missing file → empty store (no invented fact).
 * Corrupt or incomplete JSON (including a row without id or recordId) → refuse.
 * Do not reconstruct a fact from guesswork. Do not skip an unscoped row.
 */
export function loadFactStore(file: string): TenantFactStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("FACT_STORE_CORRUPT", "Fact store is corrupt; refusing to invent a fact");
  }
  if (raw === undefined) return { facts: [] };
  return parseStore(raw);
}

export function saveFactStore(file: string, store: TenantFactStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

function parseStore(raw: unknown): TenantFactStore {
  if (!isRecord(raw) || !Array.isArray(raw.facts)) {
    throw new AvError("FACT_STORE_CORRUPT", "Fact store is corrupt; refusing to invent a fact");
  }
  return { facts: raw.facts.map(parseFact) };
}

function parseFact(raw: unknown): TenantFact {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.recordId !== "string" ||
    !raw.recordId
  ) {
    throw new AvError("FACT_STORE_CORRUPT", "Fact store is corrupt; refusing to invent a fact");
  }
  return { id: raw.id, recordId: raw.recordId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
