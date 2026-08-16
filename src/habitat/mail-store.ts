import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Habitat mail on the tenant computer (CS-018 / D10).
 * Same class as routines / adapter-bind: core-owned, beside disk/, never a field file.
 * In-process AgentMail is not this store (same pattern as MemoryTiers vs habitat memory).
 */
export interface HabitatMailItem {
  mailId: string;
  tenantId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  createdAt: string;
  confersAuthority: false;
}

export interface TenantMailStore {
  items: HabitatMailItem[];
}

/**
 * Load tenants/{id}/mail.json. Missing file → empty (no invent).
 * Corrupt or incomplete JSON → refuse. Do not invent mail.
 */
export function loadMailStore(file: string, opts?: { required?: boolean }): TenantMailStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("MAIL_STORE_CORRUPT", "Mail store is corrupt; refusing to invent mail");
  }
  if (raw === undefined) {
    if (opts?.required) {
      throw new AvError("MAIL_STORE_MISSING", "Mail store is missing; refusing to invent mail");
    }
    return { items: [] };
  }
  return parseStore(raw);
}

export function saveMailStore(file: string, store: TenantMailStore): void {
  writeJsonAtomic(file, store);
}

export function mailFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).mailFile;
}

export function readTenantMail(
  computerBaseDir: string | undefined,
  tenantId: string,
  opts?: { required?: boolean },
): TenantMailStore {
  if (!computerBaseDir) {
    if (opts?.required) {
      throw new AvError("MAIL_STORE_MISSING", "Mail store is missing; refusing to invent mail");
    }
    return { items: [] };
  }
  return loadMailStore(mailFile(computerBaseDir, tenantId), opts);
}

export function findStoredMail(
  store: TenantMailStore,
  tenantId: string,
  mailId: string,
): HabitatMailItem | undefined {
  return store.items.find((row) => row.mailId === mailId && row.tenantId === tenantId);
}

export function appendMail(store: TenantMailStore, item: HabitatMailItem): TenantMailStore {
  return { items: [...store.items, item] };
}

function parseStore(raw: unknown): TenantMailStore {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new AvError("MAIL_STORE_CORRUPT", "Mail store is corrupt; refusing to invent mail");
  }
  return { items: raw.items.map(parseItem) };
}

function parseItem(raw: unknown): HabitatMailItem {
  if (
    !isRecord(raw) ||
    typeof raw.mailId !== "string" ||
    !raw.mailId.trim() ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.fromAgentId !== "string" ||
    !raw.fromAgentId.trim() ||
    typeof raw.toAgentId !== "string" ||
    !raw.toAgentId.trim() ||
    typeof raw.body !== "string" ||
    typeof raw.createdAt !== "string" ||
    !raw.createdAt ||
    raw.confersAuthority !== false
  ) {
    throw new AvError("MAIL_STORE_CORRUPT", "Mail store is corrupt; refusing to invent mail");
  }
  return {
    mailId: raw.mailId.trim(),
    tenantId: raw.tenantId,
    fromAgentId: raw.fromAgentId.trim(),
    toAgentId: raw.toAgentId.trim(),
    body: raw.body,
    createdAt: raw.createdAt,
    confersAuthority: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
