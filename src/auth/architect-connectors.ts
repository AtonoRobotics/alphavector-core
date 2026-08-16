import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  connectorBindFile,
  findStoredConnectorBind,
  readTenantConnectorBinds,
  saveConnectorBindStore,
  upsertConnectorBind,
  type ConnectorBindRecord,
} from "../habitat/connector-bind.js";
import {
  connectorCredentialsFile,
  findStoredConnectorCredentials,
  readTenantConnectorCredentials,
  saveConnectorCredentialsStore,
  upsertConnectorCredentials,
  type ConnectorCredentialsRecord,
} from "../habitat/connector-credentials.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/connector-bind.json (DEC-020).
 * Same class as adapter-bind / routines / mail / deadlines. Shell is not Architect.
 * Field SHALL NOT bind, see, or edit. Not a /field route. Not Temporal.
 * Pack connectors[] is not live until this write.
 */
export function architectBindConnector(input: {
  tenantId: string;
  connectorId: string;
  computerBaseDir: string;
  architectToken?: string;
  requiresCredentials?: boolean;
  /** Architect-written world URL. Not a field setter. Not a hardcoded vendor host. */
  baseUrl?: string;
}): ConnectorBindRecord {
  const connectorId = input.connectorId.trim();
  if (!connectorId) {
    throw new AvError("CONNECTOR_ID_REQUIRED", "Architect connector bind requires a connector id");
  }
  const baseUrl = input.baseUrl?.trim() || undefined;
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const file = connectorBindFile(input.computerBaseDir, input.tenantId);
  const current = readTenantConnectorBinds(input.computerBaseDir, input.tenantId);
  const existing = findStoredConnectorBind(current, input.tenantId, connectorId);
  const record: ConnectorBindRecord = {
    connectorId,
    tenantId: input.tenantId,
    boundBy: "architect",
    boundAt: existing?.boundAt ?? nowIso(),
    requiresCredentials: input.requiresCredentials === true,
    ...(baseUrl ? { baseUrl } : existing?.baseUrl ? { baseUrl: existing.baseUrl } : {}),
  };
  saveConnectorBindStore(file, upsertConnectorBind(current, record));
  return record;
}

/**
 * Architect writes tenants/{id}/connector-credentials.json.
 * Same write gate as adapter-credentials and connector-bind. Shell is not Architect.
 * Field SHALL NOT set, see, or edit. Not a /field route. Not on connector-bind.json.
 */
export function architectWriteConnectorCredentials(input: {
  tenantId: string;
  connectorId: string;
  secret: string;
  computerBaseDir: string;
  architectToken?: string;
}): ConnectorCredentialsRecord {
  const connectorId = input.connectorId.trim();
  const secret = input.secret.trim();
  if (!connectorId) {
    throw new AvError("CONNECTOR_ID_REQUIRED", "Architect connector credentials write requires a connector id");
  }
  if (!secret) {
    throw new AvError(
      "CONNECTOR_CREDENTIALS_REQUIRED",
      "Architect connector credentials write requires a secret",
    );
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const file = connectorCredentialsFile(input.computerBaseDir, input.tenantId);
  const current = readTenantConnectorCredentials(input.computerBaseDir, input.tenantId);
  const existing = findStoredConnectorCredentials(current, input.tenantId, connectorId);
  const record: ConnectorCredentialsRecord = {
    connectorId,
    tenantId: input.tenantId,
    secret,
    writtenBy: "architect",
    writtenAt: existing?.writtenAt ?? nowIso(),
  };
  saveConnectorCredentialsStore(file, upsertConnectorCredentials(current, record));
  return record;
}
