import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { computerRoot } from "../computer/paths.js";
import { AvError, SurfaceViolationError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { PrincipalKind } from "../packs/types.js";
import { loadTokenStore, saveTokenStore } from "./field-token-store.js";
import type { FieldTokenIssuer, FieldTokenRecord, IssuedFieldToken } from "./types.js";

/**
 * Tenant-issued field and Architect credentials. Optional computerBaseDir persists
 * on the tenant computer core owns — beside secrets/ and cards.json, never inside
 * disk/ and never in a pack.
 *
 * Issue and revoke derive the issuer from a presented credential (lookup), not
 * from a caller-supplied actor string. Empty presented is bootstrap-once of the
 * first Architect only. The last Architect credential cannot be revoked.
 */
export class FieldTokenBook {
  private readonly records = new Map<string, FieldTokenRecord>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  /**
   * Issue a credential. `presented` is a secret looked up on this tenant.
   * Omit or leave empty only to bootstrap the first Architect. A caller-supplied
   * actor string is not a principal and cannot authorize issue.
   */
  issue(input: {
    tenantId: string;
    principal: PrincipalKind;
    presented?: string;
  }): IssuedFieldToken {
    const issuedBy = this.requireIssuer(input.tenantId, input.presented, {
      bootstrap: input.principal === "architect",
    });
    const token = randomBytes(32).toString("base64url");
    const record: FieldTokenRecord = {
      tokenId: newId("ftok"),
      tenantId: input.tenantId,
      principal: input.principal,
      hash: hashSecret(token),
      status: "active",
      issuedAt: nowIso(),
      issuedBy,
    };
    this.records.set(record.tokenId, record);
    this.persist(input.tenantId);
    return {
      tokenId: record.tokenId,
      tenantId: record.tenantId,
      principal: record.principal,
      token,
    };
  }

  /**
   * Revoke a credential. Requires a presented active Architect secret.
   * Refuses if the target is the last active Architect. No recovery bootstrap.
   */
  revoke(input: { tenantId: string; tokenId: string; presented?: string }): void {
    this.requireIssuer(input.tenantId, input.presented, { bootstrap: false });
    const record = this.records.get(input.tokenId);
    if (!record || record.tenantId !== input.tenantId) {
      throw new AvError("TOKEN_NOT_FOUND", `Unknown field token ${input.tokenId}`);
    }
    if (record.status === "revoked") return;
    if (record.principal === "architect" && this.activeArchitectCount(input.tenantId) <= 1) {
      throw new SurfaceViolationError("The last Architect credential cannot be revoked");
    }
    this.records.set(record.tokenId, { ...record, status: "revoked", revokedAt: nowIso() });
    this.persist(input.tenantId);
  }

  /**
   * Resolve a presented secret for this tenant. Missing, unknown, or revoked → undefined.
   * Corrupt store throws. Does not invent a session.
   */
  lookup(secret: string, tenantId: string): PrincipalKind | undefined {
    const record = this.match(secret, tenantId);
    if (!record || record.status !== "active") return undefined;
    return record.principal;
  }

  /** True when this tenant has at least one active Architect credential. */
  hasActiveArchitect(tenantId: string): boolean {
    return this.activeArchitectCount(tenantId) > 0;
  }

  private requireIssuer(
    tenantId: string,
    presented: string | undefined,
    opts: { bootstrap: boolean },
  ): FieldTokenIssuer {
    const secret = presented?.trim() ? presented.trim() : undefined;
    if (secret) {
      const principal = this.lookup(secret, tenantId);
      if (principal === "architect") return "architect";
      if (principal === "field") {
        throw new SurfaceViolationError("A field token cannot issue or revoke");
      }
      if (principal) {
        throw new SurfaceViolationError("Only an Architect credential may issue or revoke");
      }
      throw new AvError("UNAUTHORIZED", "Unknown or revoked Architect credential");
    }
    if (opts.bootstrap && !this.hasActiveArchitect(tenantId)) {
      return "bootstrap";
    }
    throw new SurfaceViolationError("Shell is not Architect. Present an Architect credential.");
  }

  private activeArchitectCount(tenantId: string): number {
    this.ensure(tenantId);
    let count = 0;
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.principal === "architect" && record.status === "active") {
        count += 1;
      }
    }
    return count;
  }

  private match(secret: string, tenantId: string): FieldTokenRecord | undefined {
    if (!secret) return undefined;
    this.ensure(tenantId);
    const presented = hashSecret(secret);
    for (const record of this.records.values()) {
      if (record.tenantId !== tenantId) continue;
      if (hashesEqual(record.hash, presented)) return record;
    }
    return undefined;
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadTokenStore(this.fileFor(tenantId));
      for (const record of store.tokens) this.records.set(record.tokenId, record);
    } catch (err) {
      const closed =
        err instanceof AvError
          ? err
          : new AvError("TOKEN_STORE_CORRUPT", "Token store is corrupt; refusing to invent a token");
      this.corrupt.set(tenantId, closed);
      throw closed;
    }
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    const tokens = [...this.records.values()].filter((r) => r.tenantId === tenantId);
    saveTokenStore(this.fileFor(tenantId), { tokens });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).fieldTokensFile;
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
