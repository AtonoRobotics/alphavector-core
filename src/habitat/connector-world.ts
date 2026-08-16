import { AvError } from "../errors.js";
import type { LoadedPack } from "../packs/types.js";
import {
  findStoredConnectorBind,
  readTenantConnectorBinds,
  type ConnectorBindRecord,
} from "./connector-bind.js";
import { findStoredConnectorCredentials, readTenantConnectorCredentials } from "./connector-credentials.js";

/**
 * Live connector handle. Architect bind + credentials on tenant disk.
 * Models and ledgers receive this handle, never the secret.
 * In-process ConnectorBook is not this handle.
 */
export interface LiveConnectorHandle {
  handleId: string;
  connectorId: string;
  baseUrl: string;
}

/** Handles only. Never the Architect-written secret. */
export interface ConnectorWorldBody {
  handleId: string;
  connectorId: string;
  actionClass: string;
  channel?: string;
  purpose?: string;
  subject?: string;
}

export interface ConnectorWorldInput {
  computerBaseDir?: string;
  tenantId: string;
  pack: LoadedPack;
  actionClass: string;
  channel?: string;
  purpose?: string;
  subject?: string;
}

/**
 * After admission, invoke the live connector handle and reach the world.
 * Unbound / missing URL / missing required credentials / unreachable / rejected
 * fail closed. Does not write a ledger row.
 */
export async function invokeConnectorWorld(input: ConnectorWorldInput): Promise<LiveConnectorHandle> {
  const handle = resolveLiveConnectorHandle(input);
  const secret = readConnectorSecret(input.computerBaseDir, input.tenantId, handle.connectorId);
  const body: ConnectorWorldBody = {
    handleId: handle.handleId,
    connectorId: handle.connectorId,
    actionClass: input.actionClass,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
  };
  let res: Response;
  try {
    res = await fetch(handle.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AvError("CONNECTOR_UNREACHABLE", "Live connector HTTP call failed closed");
  }
  if (res.status === 401 || res.status === 403) {
    throw new AvError(
      "CONNECTOR_CREDENTIALS_REJECTED",
      "World rejected the Architect-written connector credentials",
    );
  }
  if (!res.ok) {
    throw new AvError("CONNECTOR_REJECTED", "World rejected the live connector call");
  }
  return handle;
}

export function resolveLiveConnectorHandle(input: ConnectorWorldInput): LiveConnectorHandle {
  const store = readTenantConnectorBinds(input.computerBaseDir, input.tenantId);
  const bound = resolveBoundConnector(store.connectors, input);
  if (!bound) {
    throw new AvError(
      "CONNECTOR_UNBOUND",
      "Architect must bind a live connector before an approved external effect; no silent no-op",
    );
  }
  const baseUrl = bound.baseUrl?.trim();
  if (!baseUrl) {
    throw new AvError(
      "CONNECTOR_UNBOUND",
      "Architect must bind a live connector URL before an approved external effect; no silent no-op",
    );
  }
  if (bound.requiresCredentials) {
    const creds = readTenantConnectorCredentials(input.computerBaseDir, input.tenantId);
    const secret = findStoredConnectorCredentials(creds, input.tenantId, bound.connectorId);
    if (!secret) {
      throw new AvError(
        "CONNECTOR_CREDENTIALS_MISSING",
        "Architect must write connector credentials before an approved external effect; no silent no-op",
      );
    }
  }
  return {
    handleId: `handle:${bound.connectorId}`,
    connectorId: bound.connectorId,
    baseUrl,
  };
}

function resolveBoundConnector(
  rows: ConnectorBindRecord[],
  input: ConnectorWorldInput,
): ConnectorBindRecord | undefined {
  const tenantRows = rows.filter((row) => row.tenantId === input.tenantId);
  const channel = input.channel?.trim();
  if (channel) {
    const byChannel = findStoredConnectorBind({ connectors: tenantRows }, input.tenantId, channel);
    if (byChannel) return byChannel;
  }
  for (const declared of input.pack.binding.connectors) {
    const found = findStoredConnectorBind({ connectors: tenantRows }, input.tenantId, declared.id);
    if (found) return found;
  }
  return tenantRows[0];
}

function readConnectorSecret(
  computerBaseDir: string | undefined,
  tenantId: string,
  connectorId: string,
): string | undefined {
  const creds = readTenantConnectorCredentials(computerBaseDir, tenantId);
  return findStoredConnectorCredentials(creds, tenantId, connectorId)?.secret.trim();
}
