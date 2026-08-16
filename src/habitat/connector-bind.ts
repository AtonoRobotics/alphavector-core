import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written connector bind on the tenant computer.
 * Same class as adapter-bind / routines / mail / deadlines: core-owned, beside
 * disk/, never a field file, never a createDeepAgent option.
 * In-process ConnectorBook is not this store (same pattern as AgentMail vs mail.json).
 * Pack connectors[] is not live until Architect writes a bind here.
 */
export interface ConnectorBindRecord {
  connectorId: string;
  tenantId: string;
  boundBy: "architect";
  boundAt: string;
  requiresCredentials: boolean;
}

export interface TenantConnectorBindStore {
  connectors: ConnectorBindRecord[];
}

const CREDENTIAL_KEYS = ["apiKey", "secret", "credential", "token", "password"] as const;

/**
 * Load tenants/{id}/connector-bind.json. Missing file → empty (no invent).
 * Corrupt or incomplete JSON → refuse. Do not invent a bind.
 */
export function loadConnectorBindStore(file: string, opts?: { required?: boolean }): TenantConnectorBindStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("CONNECTOR_STORE_CORRUPT", "Connector store is corrupt; refusing to invent a bind");
  }
  if (raw === undefined) {
    if (opts?.required) {
      throw new AvError("CONNECTOR_UNBOUND", "Connector store is missing; Architect must bind before admit");
    }
    return { connectors: [] };
  }
  return parseStore(raw);
}

export function saveConnectorBindStore(file: string, store: TenantConnectorBindStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

export function connectorBindFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).connectorBindFile;
}

export function readTenantConnectorBinds(
  computerBaseDir: string | undefined,
  tenantId: string,
  opts?: { required?: boolean },
): TenantConnectorBindStore {
  if (!computerBaseDir) {
    if (opts?.required) {
      throw new AvError("CONNECTOR_UNBOUND", "Connector store is missing; Architect must bind before admit");
    }
    return { connectors: [] };
  }
  return loadConnectorBindStore(connectorBindFile(computerBaseDir, tenantId), opts);
}

export function findStoredConnectorBind(
  store: TenantConnectorBindStore,
  tenantId: string,
  connectorId: string,
): ConnectorBindRecord | undefined {
  return store.connectors.find((row) => row.connectorId === connectorId && row.tenantId === tenantId);
}

export function upsertConnectorBind(
  store: TenantConnectorBindStore,
  record: ConnectorBindRecord,
): TenantConnectorBindStore {
  const next = store.connectors.filter(
    (row) => !(row.connectorId === record.connectorId && row.tenantId === record.tenantId),
  );
  next.push(record);
  return { connectors: next };
}

function parseStore(raw: unknown): TenantConnectorBindStore {
  if (!isRecord(raw) || !Array.isArray(raw.connectors)) {
    throw new AvError("CONNECTOR_STORE_CORRUPT", "Connector store is corrupt; refusing to invent a bind");
  }
  return { connectors: raw.connectors.map(parseBind) };
}

function parseBind(raw: unknown): ConnectorBindRecord {
  if (!isRecord(raw)) {
    throw new AvError("CONNECTOR_STORE_CORRUPT", "Connector store is corrupt; refusing to invent a bind");
  }
  for (const key of CREDENTIAL_KEYS) {
    if (key in raw) {
      throw new AvError(
        "CONNECTOR_STORE_CORRUPT",
        "Provider credentials SHALL NOT live on connector-bind.json",
      );
    }
  }
  if (
    typeof raw.connectorId !== "string" ||
    !raw.connectorId.trim() ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    raw.boundBy !== "architect" ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt ||
    (raw.requiresCredentials !== undefined && typeof raw.requiresCredentials !== "boolean")
  ) {
    throw new AvError("CONNECTOR_STORE_CORRUPT", "Connector store is corrupt; refusing to invent a bind");
  }
  return {
    connectorId: raw.connectorId.trim(),
    tenantId: raw.tenantId,
    boundBy: "architect",
    boundAt: raw.boundAt,
    requiresCredentials: raw.requiresCredentials === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
