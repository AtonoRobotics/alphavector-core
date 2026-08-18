import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written provider credentials on the tenant computer.
 * Same class as field-tokens / adapter-bind: core-owned, beside disk/,
 * never inside the bind-mounted /home, never a field file, never on
 * adapter-bind.json, never a pack declaration, never a createDeepAgent option.
 */
export interface AdapterCredentialsRecord {
  tenantId: string;
  apiKey: string;
  /** SuperGrok / session refresh. Written through this same file. Optional. */
  refreshToken?: string;
  writtenBy: "architect";
  writtenAt: string;
}

/**
 * Load tenants/{id}/adapter-credentials.json. Missing file → undefined.
 * Corrupt or incomplete JSON → refuse. Do not invent a key.
 */
export function loadAdapterCredentials(file: string): AdapterCredentialsRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError(
      "ADAPTER_CREDENTIALS_CORRUPT",
      "Adapter credentials are corrupt; refusing to invent a key",
    );
  }
  if (raw === undefined) return undefined;
  return parseCredentials(raw);
}

export function saveAdapterCredentials(file: string, record: AdapterCredentialsRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

export function adapterCredentialsFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).adapterCredentialsFile;
}

export function readTenantAdapterCredentials(
  computerBaseDir: string | undefined,
  tenantId: string,
): AdapterCredentialsRecord | undefined {
  if (!computerBaseDir) return undefined;
  return loadAdapterCredentials(adapterCredentialsFile(computerBaseDir, tenantId));
}

function parseCredentials(raw: unknown): AdapterCredentialsRecord {
  if (!isRecord(raw)) {
    throw new AvError(
      "ADAPTER_CREDENTIALS_CORRUPT",
      "Adapter credentials are corrupt; refusing to invent a key",
    );
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.apiKey !== "string" ||
    !raw.apiKey.trim() ||
    raw.writtenBy !== "architect" ||
    typeof raw.writtenAt !== "string" ||
    !raw.writtenAt
  ) {
    throw new AvError(
      "ADAPTER_CREDENTIALS_CORRUPT",
      "Adapter credentials are corrupt; refusing to invent a key",
    );
  }
  const refreshToken =
    typeof raw.refreshToken === "string" && raw.refreshToken.trim() ? raw.refreshToken.trim() : undefined;
  return {
    tenantId: raw.tenantId,
    apiKey: raw.apiKey.trim(),
    ...(refreshToken ? { refreshToken } : {}),
    writtenBy: "architect",
    writtenAt: raw.writtenAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
