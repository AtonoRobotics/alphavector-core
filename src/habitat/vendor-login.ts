import { AvError } from "../errors.js";
import { vendorFetch } from "./vendor-fetch.js";

/**
 * Official first-party Codex CLI device-code.
 * Source: openai/codex `codex-rs/login/src/device_code_auth.rs` + `CLIENT_ID`.
 * Custom device-auth (POST /api/accounts/deviceauth/usercode, poll
 * /api/accounts/deviceauth/token, then /oauth/token). Not a generic device grant. Not POST {}.
 *
 * Architect never types an issuer. Grok/GLM are not here: those vendors
 * publish API keys, not public subscription OAuth.
 */

export type NamedSubscriptionId = "sub-codex";

export interface OfficialLoginStart {
  providerId: NamedSubscriptionId;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  poll: OfficialLoginPollHandle;
}

export type OfficialLoginPoll =
  | { status: "authorization_pending" }
  | { status: "complete"; accessToken: string };

export type OfficialLoginPollHandle = {
  kind: "codex-device";
  deviceAuthId: string;
  userCode: string;
};

export const CODEX_ISSUER = "https://auth.openai.com";
/** Public Codex CLI client. First-party openai/codex `CLIENT_ID`. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_USERCODE_PATH = "/api/accounts/deviceauth/usercode";
export const CODEX_TOKEN_POLL_PATH = "/api/accounts/deviceauth/token";
export const CODEX_OAUTH_TOKEN_PATH = "/oauth/token";
export const CODEX_VERIFICATION_PATH = "/codex/device";
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_VERIFICATION_URI = `${CODEX_ISSUER}${CODEX_VERIFICATION_PATH}`;

export function isNamedSubscriptionId(value: string): value is NamedSubscriptionId {
  return value === "sub-codex";
}

export async function startOfficialSubscriptionLogin(
  providerId: NamedSubscriptionId,
): Promise<OfficialLoginStart> {
  if (providerId !== "sub-codex") {
    throw new AvError(
      "SUBSCRIPTION_PROVIDER_REQUIRED",
      "Guided subscription login is only Codex Subscription",
    );
  }
  return startCodexDeviceLogin();
}

export async function pollOfficialSubscriptionLogin(
  handle: OfficialLoginPollHandle,
): Promise<OfficialLoginPoll> {
  if (handle.kind !== "codex-device") {
    throw new AvError(
      "SUBSCRIPTION_PROVIDER_REQUIRED",
      "Guided subscription login is only Codex Subscription",
    );
  }
  return pollCodexDeviceLogin(handle);
}

async function startCodexDeviceLogin(): Promise<OfficialLoginStart> {
  const url = `${CODEX_ISSUER}${CODEX_USERCODE_PATH}`;
  const res = await postJson(url, { client_id: CODEX_CLIENT_ID });
  if (res.status === 404) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_NOT_ENABLED",
      "Codex device-code login is not enabled. Use Codex API (usage-billed) and paste an API key. Do not type an issuer URL.",
    );
  }
  const raw = await readJsonBody(res, "SUBSCRIPTION_AUTH_REJECTED", "Codex device start returned an unusable body");
  if (!res.ok) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Codex official login rejected the device-code start");
  }
  const deviceAuthId = stringField(raw, "device_auth_id") ?? stringField(raw, "deviceAuthId");
  const userCode = stringField(raw, "user_code") ?? stringField(raw, "usercode") ?? stringField(raw, "userCode");
  if (!deviceAuthId || !userCode) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_REJECTED",
      "Codex official login must return device_auth_id and user_code",
    );
  }
  return {
    providerId: "sub-codex",
    userCode,
    verificationUri: CODEX_VERIFICATION_URI,
    intervalSec: intervalOf(raw, 5),
    poll: { kind: "codex-device", deviceAuthId, userCode },
  };
}

async function pollCodexDeviceLogin(handle: {
  deviceAuthId: string;
  userCode: string;
}): Promise<OfficialLoginPoll> {
  const url = `${CODEX_ISSUER}${CODEX_TOKEN_POLL_PATH}`;
  const res = await postJson(url, {
    device_auth_id: handle.deviceAuthId,
    user_code: handle.userCode,
  });
  if (res.status === 403 || res.status === 404) {
    return { status: "authorization_pending" };
  }
  const raw = await readJsonBody(res, "SUBSCRIPTION_AUTH_REJECTED", "Codex device poll returned an unusable body");
  if (!res.ok) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Codex official login rejected the device-code poll");
  }
  const authorizationCode = stringField(raw, "authorization_code") ?? stringField(raw, "authorizationCode");
  const codeVerifier = stringField(raw, "code_verifier") ?? stringField(raw, "codeVerifier");
  if (!authorizationCode || !codeVerifier) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_REJECTED",
      "Codex official login must return authorization_code and code_verifier",
    );
  }
  const token = await exchangeCodexAuthorizationCode(authorizationCode, codeVerifier);
  return { status: "complete", accessToken: token };
}

async function exchangeCodexAuthorizationCode(code: string, codeVerifier: string): Promise<string> {
  const url = `${CODEX_ISSUER}${CODEX_OAUTH_TOKEN_PATH}`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  let res: Response;
  try {
    res = await vendorFetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_UNREACHABLE", "Codex official token URL was unreachable");
  }
  const raw = await readJsonBody(res, "SUBSCRIPTION_AUTH_REJECTED", "Codex token exchange returned an unusable body");
  const accessToken = stringField(raw, "access_token") ?? stringField(raw, "accessToken");
  if (!res.ok || !accessToken) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Codex official login rejected the token exchange");
  }
  return accessToken;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  try {
    return await vendorFetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_UNREACHABLE", "Official subscription login was unreachable");
  }
}

async function readJsonBody(
  res: Response,
  code: string,
  message: string,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new AvError(code, message);
  }
  if (!isRecord(raw)) throw new AvError(code, message);
  return raw;
}

function intervalOf(raw: Record<string, unknown>, fallback: number): number {
  const value = raw.interval;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
