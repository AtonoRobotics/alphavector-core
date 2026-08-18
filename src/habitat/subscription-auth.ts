import { AvError } from "../errors.js";

/**
 * Vendor-agnostic device/login start. No host is invented here.
 * Architect enters the start URL, or it is already on an Architect-owned bind.
 */
export interface DeviceLoginStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  tokenUri: string;
  intervalSec: number;
}

export interface DeviceLoginPending {
  status: "authorization_pending";
}

export interface DeviceLoginComplete {
  status: "complete";
  accessToken: string;
}

export type DeviceLoginPoll = DeviceLoginPending | DeviceLoginComplete;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export function resolveSubscriptionStartUrl(input: {
  startUrl?: string;
  boundStartUrl?: string;
}): string {
  const typed = input.startUrl?.trim() ?? "";
  if (typed) return assertHttpUrl(typed);
  const bound = input.boundStartUrl?.trim() ?? "";
  if (bound) return assertHttpUrl(bound);
  throw new AvError(
    "SUBSCRIPTION_START_URL_REQUIRED",
    "Architect must enter a start URL or issuer; core does not invent a vendor host",
  );
}

export function assertHttpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AvError("SUBSCRIPTION_START_URL_INVALID", "Start URL must be an http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AvError("SUBSCRIPTION_START_URL_INVALID", "Start URL must be an http(s) URL");
  }
  return raw.replace(/\/+$/, "");
}

export async function startDeviceLogin(startUrl: string): Promise<DeviceLoginStart> {
  const url = assertHttpUrl(startUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_UNREACHABLE", "Subscription start URL was unreachable");
  }
  if (!res.ok) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription start URL rejected the sign-in start");
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription start URL returned an unusable body");
  }
  return parseDeviceStart(raw);
}

export async function pollDeviceLogin(tokenUri: string, deviceCode: string): Promise<DeviceLoginPoll> {
  const url = assertHttpUrl(tokenUri);
  const code = deviceCode.trim();
  if (!code) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription token poll is missing a device code");
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ device_code: code, grant_type: DEVICE_GRANT }),
    });
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_UNREACHABLE", "Subscription token URL was unreachable");
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription token URL returned an unusable body");
  }
  return parseDeviceToken(raw, res.ok);
}

export function parseDeviceStart(raw: unknown): DeviceLoginStart {
  if (!isRecord(raw)) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription start URL returned an unusable body");
  }
  const deviceCode = stringField(raw, "device_code") ?? stringField(raw, "deviceCode");
  const userCode = stringField(raw, "user_code") ?? stringField(raw, "userCode");
  const verificationUri =
    stringField(raw, "verification_uri") ??
    stringField(raw, "verificationUri") ??
    stringField(raw, "verification_uri_complete");
  const tokenUri = stringField(raw, "token_uri") ?? stringField(raw, "tokenUri");
  if (!deviceCode || !userCode || !verificationUri || !tokenUri) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_REJECTED",
      "Subscription start must return device_code, user_code, verification_uri, and token_uri",
    );
  }
  const intervalRaw = raw.interval;
  const intervalSec =
    typeof intervalRaw === "number" && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? Math.floor(intervalRaw)
      : 5;
  return {
    deviceCode,
    userCode,
    verificationUri: assertHttpUrl(verificationUri),
    tokenUri: assertHttpUrl(tokenUri),
    intervalSec,
  };
}

export function parseDeviceToken(raw: unknown, ok: boolean): DeviceLoginPoll {
  if (!isRecord(raw)) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription token URL returned an unusable body");
  }
  const error = stringField(raw, "error");
  if (error === "authorization_pending" || error === "slow_down") {
    return { status: "authorization_pending" };
  }
  if (error === "access_denied" || error === "expired_token") {
    throw new AvError("SUBSCRIPTION_AUTH_DENIED", "Subscription sign-in was denied or expired");
  }
  const accessToken = stringField(raw, "access_token") ?? stringField(raw, "accessToken");
  if (accessToken) {
    return { status: "complete", accessToken };
  }
  if (!ok) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription token URL rejected the poll");
  }
  throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Subscription token URL returned an unusable body");
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
