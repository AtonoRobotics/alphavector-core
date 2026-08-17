import { chmodSync } from "node:fs";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { GraduationNotice, Grant, GrantBounds, GrantState } from "./types.js";

export interface TenantGrantStore {
  grants: Grant[];
  notices: GraduationNotice[];
}

const STATES: ReadonlySet<string> = new Set(["requires_authorization", "authorized", "revoked"]);

/**
 * Load the tenant grant file. Missing file → empty store (no invented grant).
 * Corrupt or incomplete JSON → refuse. Do not reconstruct a grant from guesswork.
 * Do not treat a failed read as an empty book — that would silently un-graduate.
 */
export function loadGrantStore(file: string): TenantGrantStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  if (raw === undefined) return { grants: [], notices: [] };
  return parseStore(raw);
}

export function saveGrantStore(file: string, store: TenantGrantStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

function parseStore(raw: unknown): TenantGrantStore {
  if (!isRecord(raw) || !Array.isArray(raw.grants)) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  const grants = raw.grants.map(parseGrant);
  const notices = parseNotices(raw.notices);
  return { grants, notices };
}

function parseGrant(raw: unknown): Grant {
  if (!isRecord(raw)) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  if (
    typeof raw.grantId !== "string" ||
    !raw.grantId ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.agentId !== "string" ||
    !raw.agentId ||
    typeof raw.actionClass !== "string" ||
    !raw.actionClass ||
    !isState(raw.state) ||
    typeof raw.owner !== "string" ||
    !raw.owner ||
    typeof raw.issuedAt !== "string" ||
    !raw.issuedAt ||
    !Array.isArray(raw.evidenceIds) ||
    raw.evidenceIds.some((id) => typeof id !== "string") ||
    !Array.isArray(raw.evalIds) ||
    raw.evalIds.some((id) => typeof id !== "string")
  ) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  const grant: Grant = {
    grantId: raw.grantId,
    tenantId: raw.tenantId,
    agentId: raw.agentId,
    actionClass: raw.actionClass,
    state: raw.state,
    bounds: parseBounds(raw.bounds),
    evidenceIds: raw.evidenceIds,
    evalIds: raw.evalIds,
    owner: raw.owner,
    issuedAt: raw.issuedAt,
  };
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== "string") {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    grant.expiresAt = raw.expiresAt;
  }
  if (raw.revokeReason !== undefined) {
    if (typeof raw.revokeReason !== "string") {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    grant.revokeReason = raw.revokeReason;
  }
  if (raw.fieldNoticeIssuedAt !== undefined) {
    if (typeof raw.fieldNoticeIssuedAt !== "string") {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    grant.fieldNoticeIssuedAt = raw.fieldNoticeIssuedAt;
  }
  return grant;
}

function parseBounds(raw: unknown): GrantBounds {
  if (!isRecord(raw)) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  const bounds: GrantBounds = {};
  if (raw.channels !== undefined) {
    if (!isStringArray(raw.channels)) {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    bounds.channels = raw.channels;
  }
  if (raw.purposes !== undefined) {
    if (!isStringArray(raw.purposes)) {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    bounds.purposes = raw.purposes;
  }
  if (raw.subjectScope !== undefined) {
    if (!isStringArray(raw.subjectScope)) {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    bounds.subjectScope = raw.subjectScope;
  }
  if (raw.ratePerHour !== undefined) {
    if (typeof raw.ratePerHour !== "number" || !Number.isFinite(raw.ratePerHour)) {
      throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
    }
    bounds.ratePerHour = raw.ratePerHour;
  }
  return bounds;
}

function parseNotices(raw: unknown): GraduationNotice[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  return raw.map(parseNotice);
}

function parseNotice(raw: unknown): GraduationNotice {
  if (!isRecord(raw)) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  if (
    typeof raw.noticeId !== "string" ||
    !raw.noticeId ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.actionClass !== "string" ||
    !raw.actionClass ||
    typeof raw.businessLanguage !== "string" ||
    !raw.businessLanguage ||
    raw.killSwitchAvailable !== true ||
    typeof raw.issuedAt !== "string" ||
    !raw.issuedAt
  ) {
    throw new AvError("GRANT_STORE_CORRUPT", "Grant store is corrupt; refusing to empty the book");
  }
  return {
    noticeId: raw.noticeId,
    tenantId: raw.tenantId,
    actionClass: raw.actionClass,
    businessLanguage: raw.businessLanguage,
    killSwitchAvailable: true,
    issuedAt: raw.issuedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isState(value: unknown): value is GrantState {
  return typeof value === "string" && STATES.has(value);
}
