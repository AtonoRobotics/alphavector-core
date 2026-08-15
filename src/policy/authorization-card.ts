import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import { FailClosedError } from "../errors.js";
import { newId } from "../ids.js";
import { assertArchitect, assertSameTenant } from "../principals/guard.js";
import type { Principal } from "../principals/types.js";
import { signBytes, verifyBytes, type Ed25519KeyPair } from "../pack/signature.js";
import type { AuthorizationCard } from "./types.js";

export function cardPayload(card: Omit<AuthorizationCard, "signature">): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: card.id,
      tenantId: card.tenantId,
      issuedBy: card.issuedBy,
      verbs: [...card.verbs].sort(),
      actionClasses: [...card.actionClasses].sort(),
      expiresAt: card.expiresAt.toISOString(),
      revoked: card.revoked,
    }),
    "utf8",
  );
}

export function issueAuthorizationCard(input: {
  tenantId: string;
  principal: Principal;
  verbs: string[];
  actionClasses: string[];
  expiresAt: Date;
  issuerKey: Ed25519KeyPair;
}): AuthorizationCard {
  assertSameTenant(input.principal, input.tenantId);
  assertArchitect(input.principal, "issue authorization cards");
  const unsigned: Omit<AuthorizationCard, "signature"> = {
    id: newId("card"),
    tenantId: input.tenantId,
    issuedBy: input.principal.id,
    verbs: input.verbs,
    actionClasses: input.actionClasses,
    expiresAt: input.expiresAt,
    revoked: false,
  };
  return {
    ...unsigned,
    signature: signBytes(input.issuerKey.privateKey, cardPayload(unsigned)),
  };
}

export function verifyAuthorizationCard(
  card: AuthorizationCard,
  issuerPublicKey: string,
  clock: Clock,
): void {
  if (card.revoked) {
    throw new FailClosedError("CARD_REVOKED", "Authorization card is revoked.");
  }
  if (card.expiresAt.getTime() <= clock.now().getTime()) {
    throw new FailClosedError("CARD_EXPIRED", "Authorization card is expired.");
  }
  const unsigned: Omit<AuthorizationCard, "signature"> = {
    id: card.id,
    tenantId: card.tenantId,
    issuedBy: card.issuedBy,
    verbs: card.verbs,
    actionClasses: card.actionClasses,
    expiresAt: card.expiresAt,
    revoked: card.revoked,
  };
  if (!verifyBytes(issuerPublicKey, cardPayload(unsigned), card.signature)) {
    throw new FailClosedError("CARD_INVALID", "Authorization card signature is invalid.");
  }
}

export function cardCovers(card: AuthorizationCard, verb: string, actionClass: string): boolean {
  return card.verbs.includes(verb) || card.actionClasses.includes(actionClass);
}

export function cardFingerprint(card: AuthorizationCard): string {
  return createHash("sha256").update(card.signature).digest("hex");
}
