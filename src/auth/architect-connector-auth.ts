import { AvError } from "../errors.js";
import { newId } from "../ids.js";
import {
  isNamedConnectorId,
  pollOfficialConnectorLogin,
  startOfficialConnectorLogin,
  type NamedConnectorId,
} from "../habitat/connector-auth.js";
import { architectBindConnector, architectWriteConnectorCredentials } from "./architect-connectors.js";
import { requireArchitect } from "./require-architect.js";

/**
 * In-flight official connector login. Completing writes through existing
 * architectBindConnector + architectWriteConnectorCredentials.
 */
export interface ConnectorAuthSession {
  authId: string;
  tenantId: string;
  connectorId: NamedConnectorId;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
}

export interface ConnectorAuthHold {
  put(session: ConnectorAuthSession): void;
  get(authId: string): ConnectorAuthSession | undefined;
  drop(authId: string): void;
}

export class MemoryConnectorAuthHold implements ConnectorAuthHold {
  private readonly sessions = new Map<string, ConnectorAuthSession>();

  put(session: ConnectorAuthSession): void {
    this.sessions.set(session.authId, session);
  }

  get(authId: string): ConnectorAuthSession | undefined {
    return this.sessions.get(authId);
  }

  drop(authId: string): void {
    this.sessions.delete(authId);
  }
}

export interface ConnectorAuthStarted {
  authId: string;
  connectorId: string;
  userCode: string;
  verificationUri: string;
  status: "pending";
}

export interface ConnectorAuthPending {
  authId: string;
  status: "authorization_pending";
}

export interface ConnectorAuthBound {
  ok: true;
  authId: string;
  connectorId: string;
  boundBy: "architect";
  status: "bound";
}

export async function architectStartConnectorAuth(input: {
  tenantId: string;
  connectorId: string;
  computerBaseDir: string;
  architectToken?: string;
  hold: ConnectorAuthHold;
}): Promise<ConnectorAuthStarted> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const connectorId = input.connectorId.trim();
  if (!isNamedConnectorId(connectorId)) {
    throw new AvError(
      "CONNECTOR_PROVIDER_REQUIRED",
      "Guided connector auth is only for named connectors with published official OAuth",
    );
  }
  const started = await startOfficialConnectorLogin(connectorId);
  const session: ConnectorAuthSession = {
    authId: newId("connauth"),
    tenantId: input.tenantId,
    connectorId,
    deviceCode: started.deviceCode,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
  };
  input.hold.put(session);
  return {
    authId: session.authId,
    connectorId: session.connectorId,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    status: "pending",
  };
}

export async function architectCompleteConnectorAuth(input: {
  tenantId: string;
  authId: string;
  computerBaseDir: string;
  architectToken?: string;
  hold: ConnectorAuthHold;
}): Promise<ConnectorAuthPending | ConnectorAuthBound> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const authId = input.authId.trim();
  if (!authId) {
    throw new AvError("CONNECTOR_AUTH_REQUIRED", "Guided connector auth must be started first");
  }
  const session = input.hold.get(authId);
  if (!session || session.tenantId !== input.tenantId) {
    throw new AvError("CONNECTOR_AUTH_REQUIRED", "Guided connector auth must be started first");
  }
  let polled: Awaited<ReturnType<typeof pollOfficialConnectorLogin>>;
  try {
    polled = await pollOfficialConnectorLogin({
      connectorId: session.connectorId,
      deviceCode: session.deviceCode,
    });
  } catch (err) {
    input.hold.drop(authId);
    throw err;
  }
  if (polled.status === "authorization_pending") {
    return { authId, status: "authorization_pending" };
  }
  const bound = architectBindConnector({
    tenantId: input.tenantId,
    connectorId: session.connectorId,
    requiresCredentials: true,
    computerBaseDir: input.computerBaseDir,
    architectToken: input.architectToken,
  });
  architectWriteConnectorCredentials({
    tenantId: input.tenantId,
    connectorId: session.connectorId,
    secret: polled.secret,
    computerBaseDir: input.computerBaseDir,
    architectToken: input.architectToken,
  });
  input.hold.drop(authId);
  return {
    ok: true,
    authId,
    connectorId: bound.connectorId,
    boundBy: "architect",
    status: "bound",
  };
}
