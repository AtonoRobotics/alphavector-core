import { chmodSync, unlinkSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect habitat seat password and one-time host bootstrap.
 *
 * The deploy-held Architect credential stays in FieldTokenBook / field-tokens.json
 * (operators may also keep a host dump such as e4-artifacts/architect-token.json).
 * That credential is never a wizard field, never returned in HTTP, never shown.
 *
 * First-run authority is a one-time code written only on this tenant computer:
 *   tenants/<tenantId>/architect-bootstrap.json
 * beside field-tokens.json. Not a secret in HTML. Not an open listen.
 * After the Architect sets a password they choose, the bootstrap file is
 * consumed (deleted) and is no longer accepted as sign-in.
 *
 * The password itself is never stored. Only a salted hash lives in
 * tenants/<tenantId>/architect-password.json.
 */

export const ARCHITECT_BOOTSTRAP_FILENAME = "architect-bootstrap.json";
export const ARCHITECT_PASSWORD_FILENAME = "architect-password.json";

export function architectBootstrapRelPath(tenantId: string): string {
  const id = tenantId.trim() || "<tenantId>";
  return `tenants/${id}/${ARCHITECT_BOOTSTRAP_FILENAME}`;
}

export function architectBootstrapFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).architectBootstrapFile;
}

export function architectPasswordFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).architectPasswordFile;
}

export function hasArchitectPassword(computerBaseDir: string, tenantId: string): boolean {
  return loadPasswordRecord(architectPasswordFile(computerBaseDir, tenantId)) !== undefined;
}

/**
 * Mint a one-time host code when no password exists yet.
 * Keeps an unused file so the Architect can find it on the host.
 * Does not rotate a code already written. Does not write after a password exists.
 */
export function ensureArchitectBootstrap(computerBaseDir: string, tenantId: string): void {
  if (hasArchitectPassword(computerBaseDir, tenantId)) return;
  const file = architectBootstrapFile(computerBaseDir, tenantId);
  const existing = loadBootstrapRecord(file);
  if (existing?.code) return;
  const code = randomBytes(32).toString("base64url");
  writeHostFile(file, {
    tenantId,
    code,
    writtenAt: nowIso(),
  });
}

/** Host-only read of the unused bootstrap code. Missing or consumed → undefined. */
export function readArchitectBootstrapCode(computerBaseDir: string, tenantId: string): string | undefined {
  const record = loadBootstrapRecord(architectBootstrapFile(computerBaseDir, tenantId));
  const code = record?.code.trim() ?? "";
  return code || undefined;
}

export function verifyArchitectPassword(
  computerBaseDir: string,
  tenantId: string,
  password: string | undefined,
): boolean {
  const presented = password ?? "";
  if (!presented) return false;
  const record = loadPasswordRecord(architectPasswordFile(computerBaseDir, tenantId));
  if (!record) return false;
  return hashesEqual(record.hash, hashPassword(presented, record.salt));
}

/**
 * First Architect on this tenant sets a password they choose.
 * Requires the unused host bootstrap code. Consumes that code.
 * Does not accept the deploy-held Architect credential.
 */
export function setArchitectPassword(input: {
  tenantId: string;
  computerBaseDir: string;
  bootstrap: string | undefined;
  password: string | undefined;
  confirm: string | undefined;
}): void {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new AvError("ARCHITECT_PASSWORD_REQUIRED", "Tenant id is required");
  }
  if (hasArchitectPassword(input.computerBaseDir, tenantId)) {
    throw new AvError("UNAUTHORIZED", "Architect password already set; sign in with that password");
  }
  const password = input.password ?? "";
  const confirm = input.confirm ?? "";
  if (!password) {
    throw new AvError("ARCHITECT_PASSWORD_REQUIRED", "Choose an Architect password");
  }
  if (password !== confirm) {
    throw new AvError("ARCHITECT_PASSWORD_MISMATCH", "Password confirmation does not match");
  }
  const presented = input.bootstrap?.trim() ?? "";
  const held = readArchitectBootstrapCode(input.computerBaseDir, tenantId);
  if (!presented || !held || !secretsEqual(presented, held)) {
    throw new AvError("UNAUTHORIZED", "Host bootstrap code required to set the first Architect password");
  }
  const salt = randomBytes(16).toString("hex");
  writeHostFile(architectPasswordFile(input.computerBaseDir, tenantId), {
    tenantId,
    hash: hashPassword(password, salt),
    salt,
    writtenAt: nowIso(),
  });
  consumeArchitectBootstrap(input.computerBaseDir, tenantId);
}

function consumeArchitectBootstrap(computerBaseDir: string, tenantId: string): void {
  const file = architectBootstrapFile(computerBaseDir, tenantId);
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

interface PasswordRecord {
  tenantId: string;
  hash: string;
  salt: string;
  writtenAt: string;
}

interface BootstrapRecord {
  tenantId: string;
  code: string;
  writtenAt: string;
}

function loadPasswordRecord(file: string): PasswordRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError(
      "ARCHITECT_PASSWORD_CORRUPT",
      "Architect password store is corrupt; refusing to invent a seat",
    );
  }
  if (raw === undefined) return undefined;
  return parsePassword(raw);
}

function loadBootstrapRecord(file: string): BootstrapRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError(
      "ARCHITECT_BOOTSTRAP_CORRUPT",
      "Architect bootstrap store is corrupt; refusing to invent a seat",
    );
  }
  if (raw === undefined) return undefined;
  return parseBootstrap(raw);
}

function parsePassword(raw: unknown): PasswordRecord {
  if (!isRecord(raw)) {
    throw new AvError(
      "ARCHITECT_PASSWORD_CORRUPT",
      "Architect password store is corrupt; refusing to invent a seat",
    );
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.hash !== "string" ||
    !raw.hash ||
    typeof raw.salt !== "string" ||
    !raw.salt ||
    typeof raw.writtenAt !== "string" ||
    !raw.writtenAt
  ) {
    throw new AvError(
      "ARCHITECT_PASSWORD_CORRUPT",
      "Architect password store is corrupt; refusing to invent a seat",
    );
  }
  return {
    tenantId: raw.tenantId,
    hash: raw.hash,
    salt: raw.salt,
    writtenAt: raw.writtenAt,
  };
}

function parseBootstrap(raw: unknown): BootstrapRecord {
  if (!isRecord(raw)) {
    throw new AvError(
      "ARCHITECT_BOOTSTRAP_CORRUPT",
      "Architect bootstrap store is corrupt; refusing to invent a seat",
    );
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.code !== "string" ||
    !raw.code.trim() ||
    typeof raw.writtenAt !== "string" ||
    !raw.writtenAt
  ) {
    throw new AvError(
      "ARCHITECT_BOOTSTRAP_CORRUPT",
      "Architect bootstrap store is corrupt; refusing to invent a seat",
    );
  }
  return {
    tenantId: raw.tenantId,
    code: raw.code.trim(),
    writtenAt: raw.writtenAt,
  };
}

function writeHostFile(file: string, value: unknown): void {
  writeJsonAtomic(file, value);
  chmodSync(file, 0o600);
}

function hashPassword(password: string, salt: string): string {
  return createHash("sha256").update(`${salt}\n${password}`, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
