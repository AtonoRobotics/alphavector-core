import { AvError, SurfaceViolationError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { PrincipalKind } from "../packs/types.js";
import {
  grantBoundsRefusal,
  grantExpiryRefusal,
  type GraduationNotice,
  type Grant,
  type GrantBounds,
  type GrantState,
  type GrantUse,
} from "./types.js";

export class GrantBook {
  private readonly grants = new Map<string, Grant>();
  private readonly notices: GraduationNotice[] = [];

  private key(tenantId: string, agentId: string, actionClass: string): string {
    return `${tenantId}:${agentId}:${actionClass}`;
  }

  state(tenantId: string, agentId: string, actionClass: string, use?: GrantUse): GrantState {
    const grant = this.grants.get(this.key(tenantId, agentId, actionClass));
    if (!grant) return "requires_authorization";
    if (grantExpiryRefusal(grant.expiresAt, nowIso())) return "requires_authorization";
    if (grant.state === "authorized" && use && grantBoundsRefusal(grant.bounds, use)) {
      return "requires_authorization";
    }
    return grant.state;
  }

  /**
   * Class-level state for the habitat loop. A grant already authorized for
   * this action class SHALL be used, regardless of which pack agent it was
   * written on. The thin coder is not a second owner-auth identity.
   * When `use` is provided, persisted bounds must cover that use — a class
   * grant is not a silent yes for every channel, purpose, subject, or rate.
   */
  classState(tenantId: string, actionClass: string, use?: GrantUse): GrantState {
    const now = nowIso();
    const matches = [...this.grants.values()].filter(
      (grant) => grant.tenantId === tenantId && grant.actionClass === actionClass,
    );
    if (matches.length === 0) return "requires_authorization";
    const live = matches.filter((grant) => !grantExpiryRefusal(grant.expiresAt, now));
    const authorized = live.filter((grant) => grant.state === "authorized");
    if (use) {
      if (authorized.some((grant) => !grantBoundsRefusal(grant.bounds, use))) return "authorized";
    } else if (authorized.length > 0) {
      return "authorized";
    }
    if (matches.some((grant) => grant.state === "revoked")) return "revoked";
    return "requires_authorization";
  }

  /** Live authorized grant for this class, if the loop may use it. */
  authorizedForClass(tenantId: string, actionClass: string, use?: GrantUse): Grant | undefined {
    const now = nowIso();
    return [...this.grants.values()].find(
      (grant) =>
        grant.tenantId === tenantId &&
        grant.actionClass === actionClass &&
        grant.state === "authorized" &&
        !grantExpiryRefusal(grant.expiresAt, now) &&
        (!use || !grantBoundsRefusal(grant.bounds, use)),
    );
  }

  /**
   * Authorized grant for this class whose set expiry has passed.
   * Missing expiry is open-ended and is not returned here.
   * A live covering grant still authorizes — this is the expired record, not a silent yes.
   */
  expiredAuthorizedForClass(tenantId: string, actionClass: string): Grant | undefined {
    const now = nowIso();
    return [...this.grants.values()].find(
      (grant) =>
        grant.tenantId === tenantId &&
        grant.actionClass === actionClass &&
        grant.state === "authorized" &&
        Boolean(grantExpiryRefusal(grant.expiresAt, now)),
    );
  }

  get(tenantId: string, agentId: string, actionClass: string): Grant | undefined {
    return this.grants.get(this.key(tenantId, agentId, actionClass));
  }

  /** Architect seat: live grant records for this tenant. Absence is empty, not a flag. */
  list(tenantId: string): Grant[] {
    return [...this.grants.values()].filter((grant) => grant.tenantId === tenantId);
  }

  write(input: {
    actor: PrincipalKind;
    tenantId: string;
    agentId: string;
    actionClass: string;
    state: Exclude<GrantState, "requires_authorization">;
    bounds: GrantBounds;
    owner: string;
    evidenceIds: string[];
    evalIds: string[];
    fieldNotice?: string;
    expiresAt?: string;
  }): Grant {
    if (input.actor === "field") {
      throw new SurfaceViolationError("Field user cannot create, widen, or graduate grants");
    }
    if (input.actor !== "architect") {
      throw new SurfaceViolationError("Only Architect plus counsel/eval may write grants");
    }
    if (input.state === "authorized") {
      if (input.evidenceIds.length === 0 || input.evalIds.length === 0) {
        throw new AvError(
          "SURPRISE_GRADUATION",
          "Surprise graduation is a product failure: independent outcome evidence and eval are required",
        );
      }
      if (!input.fieldNotice || !input.fieldNotice.trim()) {
        throw new AvError(
          "SURPRISE_GRADUATION",
          "Surprise graduation is a product failure: business-language notice is required before a class leaves the field inbox",
        );
      }
      this.notices.push({
        noticeId: newId("notice"),
        tenantId: input.tenantId,
        actionClass: input.actionClass,
        businessLanguage: input.fieldNotice,
        killSwitchAvailable: true,
        issuedAt: nowIso(),
      });
    }
    const grant: Grant = {
      grantId: newId("grant"),
      tenantId: input.tenantId,
      agentId: input.agentId,
      actionClass: input.actionClass,
      state: input.state,
      bounds: input.bounds,
      evidenceIds: input.evidenceIds,
      evalIds: input.evalIds,
      owner: input.owner,
      issuedAt: nowIso(),
      expiresAt: input.expiresAt,
      fieldNoticeIssuedAt: input.state === "authorized" ? nowIso() : undefined,
    };
    this.grants.set(this.key(input.tenantId, input.agentId, input.actionClass), grant);
    return grant;
  }

  kill(input: { tenantId: string; agentId?: string; actionClass?: string; reason: string }): Grant[] {
    const revoked: Grant[] = [];
    for (const [key, grant] of this.grants) {
      if (grant.tenantId !== input.tenantId) continue;
      if (input.agentId && grant.agentId !== input.agentId) continue;
      if (input.actionClass && grant.actionClass !== input.actionClass) continue;
      const next: Grant = {
        ...grant,
        state: "revoked",
        revokeReason: input.reason,
      };
      this.grants.set(key, next);
      revoked.push(next);
    }
    return revoked;
  }

  fieldNotices(tenantId: string): GraduationNotice[] {
    return this.notices.filter((n) => n.tenantId === tenantId);
  }
}
