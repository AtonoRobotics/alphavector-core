import { randomBytes } from "node:crypto";
import { AvError } from "../errors.js";
import { vendorFetch } from "./vendor-fetch.js";

/**
 * Official first-party named-subscription login. Architect never types an issuer.
 *
 * Codex: openai/codex custom device-auth (auth.openai.com + public Codex CLI client).
 * Grok: xai-org/grok-build RFC 8628 (auth.x.ai + grok-build client in config.rs / install.sh).
 * GLM: official ZCode desktop Continue with Z.ai auth-code (client / authorize /
 * redirect / token / business-login as shipped in ZCode 3.7.7 `out/host/index.js`).
 *
 * HTTP never returns the session. Does not copy ~/.codex|grok|zcode auth files.
 */

export type NamedSubscriptionId = "sub-codex" | "sub-grok" | "sub-glm";

export interface OfficialLoginStart {
  providerId: NamedSubscriptionId;
  userCode?: string;
  verificationUri: string;
  intervalSec: number;
  poll: OfficialLoginPollHandle;
}

export type OfficialLoginPoll =
  | { status: "authorization_pending" }
  | { status: "complete"; accessToken: string; refreshToken?: string };

export type OfficialLoginPollHandle =
  | {
      kind: "codex-device";
      deviceAuthId: string;
      userCode: string;
    }
  | {
      kind: "grok-device";
      deviceCode: string;
    }
  | {
      kind: "glm-auth-code";
      state: string;
      redirectUri: string;
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

export const GROK_ISSUER = "https://auth.x.ai";
/**
 * First-party grok-build client. Same class as Codex CLI `CLIENT_ID`.
 * Source: xai-org/grok-build `crates/codegen/xai-grok-shell/src/auth/config.rs`
 * and official `install.sh` `OIDC_SCOPE=https://auth.x.ai::b1a00492-…`.
 */
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_DEVICE_PATH = "/oauth2/device/code";
export const GROK_TOKEN_PATH = "/oauth2/token";
export const GROK_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const GROK_REFERRER = "grok-build";
/** Frozen first-party Grok OAuth2 scopes from grok-build `default_oauth2_scopes`. */
export const GROK_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
] as const;

/**
 * First-party ZCode desktop Z.ai client. Same class as grok-build `CLIENT_ID`.
 * Source: official ZCode 3.7.7 AppImage (SHA matched latest.yml)
 * `out/host/index.js` / `chunk-L5EAZUIY.js` `createZaiProviderRuntimeConfig` /
 * `resolveZaiOAuthClientId` / `ZaiProviderAdapter` / `ZaiBusinessTokenResolver`.
 * No PKCE. Hold is 300s. Does not copy a host ZCode credentials file.
 */
export const GLM_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const GLM_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
export const GLM_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
export const GLM_USERINFO_URL = "https://chat.z.ai/api/oauth/userinfo";
/** Official custom-protocol callback shipped on `$G.redirectUri`. */
export const GLM_CALLBACK_URI = "zcode://oauth/callback";
/**
 * Runtime redirect ZCode desktop actually sends (`buildDesktopOAuthRedirectUriFromEnv`).
 * `https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback`
 */
export const GLM_REDIRECT_URI = `https://zcode.z.ai/app/oauth/login?redirect=${GLM_CALLBACK_URI}`;
/** Official Z.ai business-login exchange after auth-code token (`ZaiBusinessTokenResolver`). */
export const GLM_ACCOUNT_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
/** In-flight Continue with Z.ai hold. Unguessable state is valid for this long. */
export const GLM_HOLD_TTL_MS = 300_000;

const glmAuthCodes = new Map<string, { code: string; expiresAtMs: number }>();
let glmHoldNow = () => Date.now();

export function glmHoldNowMs(): number {
  return glmHoldNow();
}

export function setGlmHoldClock(now: () => number): void {
  glmHoldNow = now;
}

export function resetGlmAuthorizationHolds(): void {
  glmAuthCodes.clear();
  glmHoldNow = () => Date.now();
}

/** Internal mailbox. Product receive is ingestOfficialGlmHop, not a test hook. */
function receiveGlmAuthorizationCode(state: string, code: string): void {
  const held = state.trim();
  const issued = code.trim();
  if (!held || !issued) return;
  glmAuthCodes.set(held, { code: issued, expiresAtMs: glmHoldNow() + GLM_HOLD_TTL_MS });
}

/**
 * Habitat-visible official hop. Parses zcode://oauth/callback or the HTTPS
 * zcode.z.ai hop (query or hop HTML before scheme handoff). Never returns
 * the vendor session.
 */
export async function ingestOfficialGlmHop(
  raw: string,
): Promise<{ state: string; code: string } | undefined> {
  const direct = parseGlmAuthorizationCallback(raw);
  if (direct) {
    receiveGlmAuthorizationCode(direct.state, direct.code);
    return direct;
  }
  const fromPage = await fetchOfficialGlmHopPage(raw);
  if (!fromPage) return undefined;
  receiveGlmAuthorizationCode(fromPage.state, fromPage.code);
  return fromPage;
}

function officialGlmHopUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.hostname !== "zcode.z.ai") return undefined;
    if (url.pathname !== "/app/oauth/login") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function fetchOfficialGlmHopPage(raw: string): Promise<{ state: string; code: string } | undefined> {
  const url = officialGlmHopUrl(raw);
  if (!url) return undefined;
  let res: Response;
  try {
    res = await vendorFetch(url.toString(), { method: "GET", headers: { accept: "text/html" } });
  } catch {
    return undefined;
  }
  let html = "";
  try {
    html = await res.text();
  } catch {
    return undefined;
  }
  const extracted = extractZcodeCallbackFromHopHtml(html);
  return extracted ? parseGlmAuthorizationCallback(extracted) : undefined;
}

function extractZcodeCallbackFromHopHtml(html: string): string | undefined {
  const href = html.match(/href\s*=\s*["'](zcode:\/\/oauth\/callback[^"']*)["']/i);
  if (href?.[1]) return href[1].replace(/&amp;/g, "&");
  const bare = html.match(/zcode:\/\/oauth\/callback\?[^\s"'<>]+/i);
  return bare?.[0];
}

/**
 * Parse official hop or `zcode://oauth/callback` for matching state+code.
 * Accepts `code` or `authCode`. Does not invent PKCE.
 */
export function parseGlmAuthorizationCallback(raw: string): { state: string; code: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fromParams = (params: URLSearchParams): { state: string; code: string } | undefined => {
    const state = params.get("state")?.trim() ?? "";
    const code = (params.get("code") ?? params.get("authCode") ?? "").trim();
    if (state && code) return { state, code };
    const redirect = params.get("redirect");
    if (redirect) return parseGlmAuthorizationCallback(redirect);
    return undefined;
  };
  try {
    const url = new URL(trimmed);
    const direct = fromParams(url.searchParams);
    if (direct) return direct;
    if (url.hash.length > 1) {
      const hashed = fromParams(new URLSearchParams(url.hash.replace(/^#/, "")));
      if (hashed) return hashed;
    }
  } catch {
    const query = trimmed.replace(/^[?#]/, "");
    if (query.includes("=")) return fromParams(new URLSearchParams(query));
  }
  return undefined;
}

function takeGlmAuthorizationCode(state: string): string | undefined {
  const held = glmAuthCodes.get(state);
  if (!held) return undefined;
  if (glmHoldNow() > held.expiresAtMs) {
    glmAuthCodes.delete(state);
    return undefined;
  }
  glmAuthCodes.delete(state);
  return held.code;
}

export function isNamedSubscriptionId(value: string): value is NamedSubscriptionId {
  return value === "sub-codex" || value === "sub-grok" || value === "sub-glm";
}

export async function startOfficialSubscriptionLogin(
  providerId: NamedSubscriptionId,
): Promise<OfficialLoginStart> {
  if (providerId === "sub-codex") return startCodexDeviceLogin();
  if (providerId === "sub-grok") return startGrokDeviceLogin();
  return startGlmAccountAuthorize();
}

export async function pollOfficialSubscriptionLogin(
  handle: OfficialLoginPollHandle,
): Promise<OfficialLoginPoll> {
  if (handle.kind === "codex-device") return pollCodexDeviceLogin(handle);
  if (handle.kind === "grok-device") return pollGrokDeviceLogin(handle);
  if (handle.kind === "glm-auth-code") return pollGlmAuthCodeLogin(handle);
  throw new AvError(
    "SUBSCRIPTION_PROVIDER_REQUIRED",
    "Guided subscription login is Codex device-code, Grok device-code, or GLM auth-code",
  );
}

async function startCodexDeviceLogin(): Promise<OfficialLoginStart> {
  const url = `${CODEX_ISSUER}${CODEX_USERCODE_PATH}`;
  const res = await postJson(url, { client_id: CODEX_CLIENT_ID });
  if (res.status === 404) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_NOT_ENABLED",
      "Codex device-code login is not enabled. Do not type an issuer URL.",
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

async function startGrokDeviceLogin(): Promise<OfficialLoginStart> {
  const url = `${GROK_ISSUER}${GROK_DEVICE_PATH}`;
  const body = new URLSearchParams({
    client_id: GROK_CLIENT_ID,
    scope: GROK_SCOPES.join(" "),
    referrer: GROK_REFERRER,
  });
  let res: Response;
  try {
    res = await vendorFetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "x-grok-client-surface": "ui",
      },
      body: body.toString(),
    });
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_UNREACHABLE", "Grok official device-code URL was unreachable");
  }
  if (res.status === 404) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_NOT_ENABLED",
      "Grok device-code login is not enabled. Do not type an issuer URL.",
    );
  }
  const raw = await readJsonBody(res, "SUBSCRIPTION_AUTH_REJECTED", "Grok device start returned an unusable body");
  if (!res.ok) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Grok official login rejected the device-code start");
  }
  const deviceCode = stringField(raw, "device_code") ?? stringField(raw, "deviceCode");
  const userCode = stringField(raw, "user_code") ?? stringField(raw, "userCode");
  const verificationUri = stringField(raw, "verification_uri") ?? stringField(raw, "verificationUri");
  if (!deviceCode || !userCode || !verificationUri) {
    throw new AvError(
      "SUBSCRIPTION_AUTH_REJECTED",
      "Grok official login must return device_code, user_code, and verification_uri",
    );
  }
  return {
    providerId: "sub-grok",
    userCode,
    verificationUri: assertHttpsUrl(verificationUri),
    intervalSec: intervalOf(raw, 5),
    poll: { kind: "grok-device", deviceCode },
  };
}

async function pollGrokDeviceLogin(handle: { deviceCode: string }): Promise<OfficialLoginPoll> {
  const url = `${GROK_ISSUER}${GROK_TOKEN_PATH}`;
  const body = new URLSearchParams({
    grant_type: GROK_DEVICE_GRANT,
    device_code: handle.deviceCode,
    client_id: GROK_CLIENT_ID,
  });
  let res: Response;
  try {
    res = await vendorFetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "x-grok-client-surface": "ui",
      },
      body: body.toString(),
    });
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_UNREACHABLE", "Grok official token URL was unreachable");
  }
  const raw = await readJsonBody(res, "SUBSCRIPTION_AUTH_REJECTED", "Grok token poll returned an unusable body");
  const error = stringField(raw, "error");
  if (error === "authorization_pending" || error === "slow_down") {
    return { status: "authorization_pending" };
  }
  if (error === "access_denied" || error === "expired_token") {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Grok official login was denied or expired");
  }
  const accessToken = stringField(raw, "access_token") ?? stringField(raw, "accessToken");
  const refreshToken = stringField(raw, "refresh_token") ?? stringField(raw, "refreshToken");
  if (!res.ok || !accessToken) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Grok official login rejected the device-code poll");
  }
  return {
    status: "complete",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

function startGlmAccountAuthorize(): OfficialLoginStart {
  const state = randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    redirect_uri: GLM_REDIRECT_URI,
    response_type: "code",
    client_id: GLM_CLIENT_ID,
    state,
  });
  return {
    providerId: "sub-glm",
    verificationUri: `${GLM_AUTHORIZE_URL}?${params.toString()}`,
    intervalSec: 2,
    poll: { kind: "glm-auth-code", state, redirectUri: GLM_REDIRECT_URI },
  };
}

async function pollGlmAuthCodeLogin(handle: {
  state: string;
  redirectUri: string;
}): Promise<OfficialLoginPoll> {
  const code = takeGlmAuthorizationCode(handle.state);
  if (!code) return { status: "authorization_pending" };
  const exchanged = await exchangeGlmAuthorizationCode(code, handle);
  const accessToken = await exchangeGlmBusinessToken(exchanged.zaiAccessToken);
  return {
    status: "complete",
    accessToken,
    ...(exchanged.zcodeJwtToken ? { refreshToken: exchanged.zcodeJwtToken } : {}),
  };
}

async function exchangeGlmAuthorizationCode(
  code: string,
  handle: { state: string; redirectUri: string },
): Promise<{ zaiAccessToken: string; zcodeJwtToken?: string }> {
  const raw = await postJsonRecord(GLM_TOKEN_URL, {
    provider: "zai",
    code,
    redirect_uri: handle.redirectUri,
    state: handle.state,
  });
  const envelopeCode = raw.code;
  if (envelopeCode !== undefined && envelopeCode !== 0 && envelopeCode !== "0") {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "ZCode official login rejected the auth-code exchange");
  }
  const data = isRecord(raw.data) ? raw.data : raw;
  const zai = isRecord(data.zai) ? data.zai : undefined;
  const zaiAccessToken =
    stringField(zai ?? {}, "access_token") ?? stringField(data, "access_token") ?? stringField(data, "accessToken");
  const zcodeJwtToken = stringField(data, "token") ?? stringField(data, "zcodeJwtToken");
  if (!zaiAccessToken) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "ZCode official login must return data.zai.access_token");
  }
  return { zaiAccessToken, ...(zcodeJwtToken ? { zcodeJwtToken } : {}) };
}

async function exchangeGlmBusinessToken(oauthAccessToken: string): Promise<string> {
  const raw = await postJsonRecord(GLM_ACCOUNT_LOGIN_URL, { token: oauthAccessToken });
  const envelopeCode = raw.code;
  if (envelopeCode !== undefined && envelopeCode !== 0 && envelopeCode !== 200 && envelopeCode !== "0" && envelopeCode !== "200") {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Z.ai official login rejected the account authorize");
  }
  if (raw.success === false) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Z.ai official login rejected the account authorize");
  }
  const data = isRecord(raw.data) ? raw.data : raw;
  const accessToken = stringField(data, "access_token") ?? stringField(data, "accessToken");
  if (!accessToken) {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Z.ai official login must return a business access token");
  }
  return accessToken;
}

async function postJsonRecord(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await postJson(url, body);
  return readJsonBody(res, "SUBSCRIPTION_AUTH_REJECTED", "Official ZCode login returned an unusable body");
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

function assertHttpsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Official login returned an unusable verification URI");
  }
  if (parsed.protocol !== "https:") {
    throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "Official login returned an unusable verification URI");
  }
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
