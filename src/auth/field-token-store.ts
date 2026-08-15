import { chmodSync } from "node:fs";
import { AvError } from "../errors.js";
import type { PrincipalKind } from "../packs/types.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { FieldTokenIssuer, FieldTokenRecord, FieldTokenStatus } from "./types.js";

export interface TenantTokenStore {
  tokens: FieldTokenRecord[];
}

const PRINCIPALS: ReadonlySet<string> = new Set(["architect", "counsel_eval", "field"]);
const STATUSES: ReadonlySet<string> = new Set(["active", "revoked"]);
const ISSUERS: ReadonlySet<string> = new Set(["architect", "bootstrap"]);

/**
 * Load the tenant field-token file. Missing file → empty store (no invented sessions).
 * Corrupt or incomplete JSON → refuse. Do not reconstruct a token from guesswork.
 */
export function loadTokenStore(file: string): TenantTokenStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("TOKEN_STORE_CORRUPT", "Token store is corrupt; refusing to invent a token");
  }
  if (raw === undefined) return { tokens: [] };
  return parseStore(raw);
}

export function saveTokenStore(file: string, store: TenantTokenStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

function parseStore(raw: unknown): TenantTokenStore {
  if (!isRecord(raw) || !Array.isArray(raw.tokens)) {
    throw new AvError("TOKEN_STORE_CORRUPT", "Token store is corrupt; refusing to invent a token");
  }
  return { tokens: raw.tokens.map(parseRecord) };
}

function parseRecord(raw: unknown): FieldTokenRecord {
  if (!isRecord(raw)) {
    throw new AvError("TOKEN_STORE_CORRUPT", "Token store is corrupt; refusing to invent a token");
  }
  if (
    typeof raw.tokenId !== "string" ||
    !raw.tokenId ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    !isPrincipal(raw.principal) ||
    typeof raw.hash !== "string" ||
    !raw.hash ||
    !isStatus(raw.status) ||
    typeof raw.issuedAt !== "string" ||
    !raw.issuedAt ||
    !isIssuer(raw.issuedBy)
  ) {
    throw new AvError("TOKEN_STORE_CORRUPT", "Token store is corrupt; refusing to invent a token");
  }
  const record: FieldTokenRecord = {
    tokenId: raw.tokenId,
    tenantId: raw.tenantId,
    principal: raw.principal,
    hash: raw.hash,
    status: raw.status,
    issuedAt: raw.issuedAt,
    issuedBy: raw.issuedBy,
  };
  if (typeof raw.revokedAt === "string") record.revokedAt = raw.revokedAt;
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPrincipal(value: unknown): value is PrincipalKind {
  return typeof value === "string" && PRINCIPALS.has(value);
}

function isStatus(value: unknown): value is FieldTokenStatus {
  return typeof value === "string" && STATUSES.has(value);
}

function isIssuer(value: unknown): value is FieldTokenIssuer {
  return typeof value === "string" && ISSUERS.has(value);
}
