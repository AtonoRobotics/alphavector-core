import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** HttpOnly cookie. Not the Architect credential. HTTP never returns this secret. */
export const ARCHITECT_SESSION_COOKIE = "av_architect";
const SESSION_TTL_SEC = 12 * 60 * 60;

export interface ArchitectSessionHold {
  issue(tenantId: string): { cookie: string; maxAgeSec: number };
  lookup(tenantId: string, presented: string | undefined): boolean;
}

/**
 * Checked Architect browser session. Issued only after a verified Architect
 * credential. Cookie value is a random session secret, not the deploy-held token.
 */
export class MemoryArchitectSessionHold implements ArchitectSessionHold {
  private readonly sessions = new Map<string, { tenantId: string; hash: string; expiresAtMs: number }>();

  issue(tenantId: string): { cookie: string; maxAgeSec: number } {
    const secret = randomBytes(32).toString("base64url");
    const id = randomBytes(16).toString("hex");
    this.sessions.set(id, {
      tenantId,
      hash: hashSecret(secret),
      expiresAtMs: Date.now() + SESSION_TTL_SEC * 1000,
    });
    return { cookie: `${id}.${secret}`, maxAgeSec: SESSION_TTL_SEC };
  }

  lookup(tenantId: string, presented: string | undefined): boolean {
    const raw = presented?.trim() ?? "";
    const sep = raw.indexOf(".");
    if (sep <= 0) return false;
    const id = raw.slice(0, sep);
    const secret = raw.slice(sep + 1);
    const row = this.sessions.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    if (Date.now() > row.expiresAtMs) {
      this.sessions.delete(id);
      return false;
    }
    return timingSafeEqual(Buffer.from(row.hash), Buffer.from(hashSecret(secret)));
  }
}

export function architectSessionCookieHeader(cookie: string, maxAgeSec: number): string {
  return `${ARCHITECT_SESSION_COOKIE}=${cookie}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function readArchitectSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${ARCHITECT_SESSION_COOKIE}=`)) continue;
    const value = trimmed.slice(`${ARCHITECT_SESSION_COOKIE}=`.length).trim();
    return value || undefined;
  }
  return undefined;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
