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

/** Email/SMS send. Bound URL + Architect secret. Not a handle ping. */
export interface ConnectorSend {
  to: string;
  body: string;
  from: string;
}

/** Recorded CI / dry-stem send. Reserved .test addresses. Not a public recipient. */
export const RECORDED_EMAIL_SEND: ConnectorSend = {
  to: "to@example.test",
  from: "from@example.test",
  body: "follow-up",
};

export const SEND_CHANNELS = ["email", "sms"] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

export function isSendChannel(channel: string | undefined): channel is SendChannel {
  return channel === "email" || channel === "sms";
}

/**
 * Optional send fields copied from intent / pending / field progress.
 * Empty strings are omitted. Completeness is checked at invoke for send channels.
 */
export function connectorSendFields(input: {
  to?: string;
  body?: string;
  from?: string;
}): Partial<ConnectorSend> {
  const to = input.to?.trim();
  const body = input.body?.trim();
  const from = input.from?.trim();
  return {
    ...(to ? { to } : {}),
    ...(body ? { body } : {}),
    ...(from ? { from } : {}),
  };
}

/** Handles only. Never the Architect-written secret. Not an email/SMS send. */
export interface ConnectorWorldBody {
  handleId: string;
  connectorId: string;
  actionClass: string;
  channel?: string;
  purpose?: string;
  subject?: string;
}

/** Live send posted to the bound URL. Not a handle ping. */
export interface ConnectorSendBody extends ConnectorSend {
  channel: SendChannel;
}

export interface ConnectorWorldInput {
  computerBaseDir?: string;
  tenantId: string;
  pack: LoadedPack;
  actionClass: string;
  channel?: string;
  purpose?: string;
  subject?: string;
  to?: string;
  body?: string;
  from?: string;
}

/**
 * After admission, invoke the live connector and reach the world.
 * Email/SMS POST a send (to / body / from) to the Architect-bound URL.
 * A generic handle ping is not a send and does not count as executed.
 * Unbound / missing URL / missing required credentials / incomplete send /
 * unreachable / rejected fail closed. Does not write a ledger row.
 */
export async function invokeConnectorWorld(input: ConnectorWorldInput): Promise<LiveConnectorHandle> {
  const handle = resolveLiveConnectorHandle(input);
  const secret = readConnectorSecret(input.computerBaseDir, input.tenantId, handle.connectorId);
  const body = connectorWorldPostBody(input, handle);
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

export function requireConnectorSend(input: {
  channel?: string;
  to?: string;
  body?: string;
  from?: string;
}): ConnectorSend {
  if (!isSendChannel(input.channel)) {
    throw new AvError(
      "CONNECTOR_SEND_INCOMPLETE",
      "Email/SMS send requires an email or sms channel; no silent no-op",
    );
  }
  const send = connectorSendFields(input);
  if (!send.to || !send.body || !send.from) {
    throw new AvError(
      "CONNECTOR_SEND_INCOMPLETE",
      "Email/SMS send requires to, body, and from; no silent no-op",
    );
  }
  return { to: send.to, body: send.body, from: send.from };
}

function connectorWorldPostBody(
  input: ConnectorWorldInput,
  handle: LiveConnectorHandle,
): ConnectorSendBody | ConnectorWorldBody {
  if (isSendChannel(input.channel)) {
    const send = requireConnectorSend(input);
    return {
      to: send.to,
      body: send.body,
      from: send.from,
      channel: input.channel,
    };
  }
  return {
    handleId: handle.handleId,
    connectorId: handle.connectorId,
    actionClass: input.actionClass,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
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
  // No channel or pack-declared id match. Do not invent a default world.
  return undefined;
}

function readConnectorSecret(
  computerBaseDir: string | undefined,
  tenantId: string,
  connectorId: string,
): string | undefined {
  const creds = readTenantConnectorCredentials(computerBaseDir, tenantId);
  return findStoredConnectorCredentials(creds, tenantId, connectorId)?.secret.trim();
}
