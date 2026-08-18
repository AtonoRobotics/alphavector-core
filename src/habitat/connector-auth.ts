import { AvError } from "../errors.js";
import { vendorFetch } from "./vendor-fetch.js";

/**
 * Named connector official login. GitHub publishes device-code OAuth (first-party gh CLI).
 * Generic / private MCP is Architect-typed server URL — no baked host.
 */

export type NamedConnectorId = "github";

export interface OfficialConnectorStart {
  connectorId: NamedConnectorId;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  deviceCode: string;
}

export type OfficialConnectorPoll =
  | { status: "authorization_pending" }
  | { status: "complete"; secret: string };

export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** Public GitHub CLI OAuth app. First-party cli/cli. */
export const GITHUB_CLIENT_ID = "178c6fc778ccc68e1d6a";
export const GITHUB_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const GITHUB_SCOPES = "repo read:org";

export function isNamedConnectorId(value: string): value is NamedConnectorId {
  return value === "github";
}

export async function startOfficialConnectorLogin(connectorId: NamedConnectorId): Promise<OfficialConnectorStart> {
  if (connectorId === "github") return startGithubDeviceLogin();
  throw new AvError("CONNECTOR_PROVIDER_REQUIRED", "Named connector login is only for published official OAuth");
}

export async function pollOfficialConnectorLogin(input: {
  connectorId: NamedConnectorId;
  deviceCode: string;
}): Promise<OfficialConnectorPoll> {
  if (input.connectorId === "github") return pollGithubDeviceLogin(input.deviceCode);
  throw new AvError("CONNECTOR_PROVIDER_REQUIRED", "Named connector login is only for published official OAuth");
}

async function startGithubDeviceLogin(): Promise<OfficialConnectorStart> {
  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
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
  };
}

async function pollGithubDeviceLogin(deviceCode: string): Promise<OfficialConnectorPoll> {
  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
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
