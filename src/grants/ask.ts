import { AvError } from "../errors.js";
import type { ActionCeiling } from "../packs/types.js";
import type { GrantBook } from "./store.js";
import type { HabitatAskReason } from "./types.js";

export interface HabitatAskInput {
  grants: GrantBook;
  tenantId: string;
  actionClass: string;
  /** Proposed class when it may differ from the authorized grant's class. */
  proposedClass?: string;
  ceiling?: ActionCeiling;
}

/**
 * Whether the habitat loop may mint a new owner_instance card.
 * `undefined` means an authorized grant for that class already exists — use it.
 */
export function habitatAskReason(input: HabitatAskInput): HabitatAskReason | undefined {
  const actionClass = input.proposedClass ?? input.actionClass;
  const state = input.grants.classState(input.tenantId, actionClass);
  if (state === "authorized") {
    if (input.ceiling === "human_decision") return "human_decision";
    return undefined;
  }
  if (state === "revoked") return "grant_revoked";
  const otherAuthorized = input.grants
    .list(input.tenantId)
    .some(
      (grant) =>
        grant.actionClass !== actionClass &&
        input.grants.classState(input.tenantId, grant.actionClass) === "authorized",
    );
  if (otherAuthorized) return "class_mismatch";
  return "no_grant";
}

/**
 * Re-ask without a reason is a habitat bug, not safety.
 * Does not mint a card. Fail closed.
 */
export function assertHabitatMayAsk(reason: HabitatAskReason | undefined): HabitatAskReason {
  if (!reason) {
    throw new AvError(
      "HABITAT_REASK",
      "Re-ask without a reason is a habitat bug; an authorized grant for that class must be used",
    );
  }
  return reason;
}
