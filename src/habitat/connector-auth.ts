import { AvError } from "../errors.js";
import { vendorFetch } from "./vendor-fetch.js";

/**
 * Named connector OAuth uses OUR GitHub OAuth App registration (Architect-supplied
 * client_id) on GitHub's published device endpoints. Not OpenAI's connector catalog.
 * Not the first-party GitHub CLI client. Generic / private MCP is Architect-typed
 * server URL — no baked host.
 */

export type NamedConnectorId = "github";

export interface OfficialConnectorStart {
  connectorId: NamedConnectorId;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  deviceCode: string;
  clientId: string;
}

export type OfficialConnectorPoll =
  | { status: "authorization_pending" }
  | { status: "complete"; secret: string };

/** GitHub-published device authorization. https://docs.github.com/apps/oauth-apps */
export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const GITHUB_SCOPES = "repo read:org";

export function isNamedConnectorId(value: string): value is NamedConnectorId {
  return value === "github";
}

export async function startOfficialConnectorLogin(
  connectorId: NamedConnectorId,
  clientId: string,
): Promise<OfficialConnectorStart> {
  if (connectorId !== "github") {
    throw new AvError("CONNECTOR_PROVIDER_REQUIRED", "Named connector login is only GitHub with our OAuth App");
  }
  return startGithubDeviceLogin(requireClientId(clientId));
}

export async function pollOfficialConnectorLogin(input: {
  connectorId: NamedConnectorId;
  deviceCode: string;
  clientId: string;
}): Promise<OfficialConnectorPoll> {
  if (input.connectorId !== "github") {
    throw new AvError("CONNECTOR_PROVIDER_REQUIRED", "Named connector login is only GitHub with our OAuth App");
  }
  return pollGithubDeviceLogin(input.deviceCode, requireClientId(input.clientId));
}

function requireClientId(clientId: string): string {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new AvError(
      "CONNECTOR_CLIENT_REQUIRED",
      "GitHub attach needs this habitat's OAuth App client id. Register a GitHub OAuth App; do not type a mystery issuer.",
    );
  }
  return trimmed;
}

async function startGithubDeviceLogin(clientId: string): Promise<OfficialConnectorStart> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: GITHUB_SCOPES,
  });
  let res: Response;
  try {
    res = await vendorFetch(GITHUB_DEVICE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch {
    throw new AvError("CONNECTOR_AUTH_UNREACHABLE", "GitHub official device-code URL was unreachable");
  }
  const raw = await readJson(res, "GitHub device start returned an unusable body");
  if (!res.ok) {
    throw new AvError("CONNECTOR_AUTH_REJECTED", "GitHub official login rejected the device-code start");
  }
  const deviceCode = stringField(raw, "device_code");
  const userCode = stringField(raw, "user_code");
  const verificationUri = stringField(raw, "verification_uri");
  if (!deviceCode || !userCode || !verificationUri) {
    throw new AvError(
      "CONNECTOR_AUTH_REJECTED",
      "GitHub official login must return device_code, user_code, and verification_uri",
    );
  }
  return {
    connectorId: "github",
    userCode,
    verificationUri,
    intervalSec: intervalOf(raw, 5),
    deviceCode,
    clientId,
  };
}

async function pollGithubDeviceLogin(deviceCode: string, clientId: string): Promise<OfficialConnectorPoll> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: GITHUB_DEVICE_GRANT,
  });
  let res: Response;
  try {
    res = await vendorFetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch {
    throw new AvError("CONNECTOR_AUTH_UNREACHABLE", "GitHub official token URL was unreachable");
  }
  const raw = await readJson(res, "GitHub token poll returned an unusable body");
  const error = stringField(raw, "error");
  if (error === "authorization_pending" || error === "slow_down") {
    return { status: "authorization_pending" };
  }
  if (error === "access_denied" || error === "expired_token") {
    throw new AvError("CONNECTOR_AUTH_DENIED", "GitHub sign-in was denied or expired");
  }
  const secret = stringField(raw, "access_token");
  if (secret) return { status: "complete", secret };
  if (!res.ok) {
    throw new AvError("CONNECTOR_AUTH_REJECTED", "GitHub official login rejected the token poll");
  }
  throw new AvError("CONNECTOR_AUTH_REJECTED", "GitHub official login returned an unusable token body");
}

async function readJson(res: Response, message: string): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new AvError("CONNECTOR_AUTH_REJECTED", message);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AvError("CONNECTOR_AUTH_REJECTED", message);
  }
  return raw as Record<string, unknown>;
}

function intervalOf(raw: Record<string, unknown>, fallback: number): number {
  const value = raw.interval;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
