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
 */
export class FieldTokenBook {
  private readonly records = new Map<string, FieldTokenRecord>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  issue(input: {
    tenantId: string;
    principal: PrincipalKind;
    actor: string;
  }): IssuedFieldToken {
    this.assertIssuer(input.actor);
    this.ensure(input.tenantId);
    const token = randomBytes(32).toString("base64url");
    const record: FieldTokenRecord = {
      tokenId: newId("ftok"),
      tenantId: input.tenantId,
      principal: input.principal,
      hash: hashSecret(token),
      status: "active",
      issuedAt: nowIso(),
      issuedBy: input.actor,
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

  revoke(input: { tenantId: string; tokenId: string; actor: string }): void {
    this.assertIssuer(input.actor);
    this.ensure(input.tenantId);
    const record = this.records.get(input.tokenId);
    if (!record || record.tenantId !== input.tenantId) {
      throw new AvError("TOKEN_NOT_FOUND", `Unknown field token ${input.tokenId}`);
    }
    if (record.status === "revoked") return;
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
    this.ensure(tenantId);
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.principal === "architect" && record.status === "active") {
        return true;
      }
    }
    return false;
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

  private assertIssuer(actor: string): asserts actor is FieldTokenIssuer {
    if (actor !== "architect" && actor !== "bootstrap") {
      throw new SurfaceViolationError("Only architect or tenant bootstrap may issue or revoke a field token");
    }
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
