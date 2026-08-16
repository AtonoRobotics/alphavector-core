import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written connector credentials on the tenant computer.
 * Same class as adapter-credentials / field-tokens: core-owned, beside disk/,
 * never inside the bind-mounted /home, never a field file, never on
 * connector-bind.json, never a pack declaration, never a createDeepAgent option.
 * Models receive handles, never these secrets.
 */
export interface ConnectorCredentialsRecord {
  connectorId: string;
  tenantId: string;
  secret: string;
  writtenBy: "architect";
  writtenAt: string;
}

export interface TenantConnectorCredentialsStore {
  credentials: ConnectorCredentialsRecord[];
}

/**
 * Load tenants/{id}/connector-credentials.json. Missing file → empty (no invent).
 * Corrupt or incomplete JSON → refuse. Do not invent a secret.
 */
export function loadConnectorCredentialsStore(
  file: string,
  opts?: { required?: boolean },
): TenantConnectorCredentialsStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError(
      "CONNECTOR_STORE_CORRUPT",
      "Connector credentials are corrupt; refusing to invent a secret",
    );
  }
  if (raw === undefined) {
    if (opts?.required) {
      throw new AvError(
        "CONNECTOR_CREDENTIALS_MISSING",
        "Connector credentials are missing; Architect must write them before admit",
      );
    }
    return { credentials: [] };
  }
  return parseStore(raw);
}

export function saveConnectorCredentialsStore(file: string, store: TenantConnectorCredentialsStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

export function connectorCredentialsFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).connectorCredentialsFile;
}

export function readTenantConnectorCredentials(
  computerBaseDir: string | undefined,
  tenantId: string,
  opts?: { required?: boolean },
): TenantConnectorCredentialsStore {
  if (!computerBaseDir) {
    if (opts?.required) {
      throw new AvError(
        "CONNECTOR_CREDENTIALS_MISSING",
        "Connector credentials are missing; Architect must write them before admit",
      );
    }
    return { credentials: [] };
  }
  return loadConnectorCredentialsStore(connectorCredentialsFile(computerBaseDir, tenantId), opts);
}

export function findStoredConnectorCredentials(
  store: TenantConnectorCredentialsStore,
  tenantId: string,
  connectorId: string,
): ConnectorCredentialsRecord | undefined {
  return store.credentials.find((row) => row.connectorId === connectorId && row.tenantId === tenantId);
}

export function upsertConnectorCredentials(
  store: TenantConnectorCredentialsStore,
  record: ConnectorCredentialsRecord,
): TenantConnectorCredentialsStore {
  const next = store.credentials.filter(
    (row) => !(row.connectorId === record.connectorId && row.tenantId === record.tenantId),
  );
  next.push(record);
  return { credentials: next };
}

function parseStore(raw: unknown): TenantConnectorCredentialsStore {
  if (!isRecord(raw) || !Array.isArray(raw.credentials)) {
    throw new AvError(
      "CONNECTOR_STORE_CORRUPT",
      "Connector credentials are corrupt; refusing to invent a secret",
    );
  }
  return { credentials: raw.credentials.map(parseCredentials) };
}

function parseCredentials(raw: unknown): ConnectorCredentialsRecord {
  if (
    !isRecord(raw) ||
    typeof raw.connectorId !== "string" ||
    !raw.connectorId.trim() ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.secret !== "string" ||
    !raw.secret.trim() ||
    raw.writtenBy !== "architect" ||
    typeof raw.writtenAt !== "string" ||
    !raw.writtenAt
  ) {
    throw new AvError(
      "CONNECTOR_STORE_CORRUPT",
      "Connector credentials are corrupt; refusing to invent a secret",
    );
  }
  return {
    connectorId: raw.connectorId.trim(),
    tenantId: raw.tenantId,
    secret: raw.secret.trim(),
    writtenBy: "architect",
    writtenAt: raw.writtenAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
