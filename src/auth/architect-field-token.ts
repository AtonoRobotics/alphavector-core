import type { PrincipalKind } from "../packs/types.js";
import { FieldTokenBook } from "./field-tokens.js";
import type { IssuedFieldToken } from "./types.js";

/**
 * Architect issues and revokes tokens off the field home screen.
 * Shell access is not Architect. Present an Architect credential stored on
 * the tenant computer (FieldTokenBook / field-tokens.json).
 * The book derives the issuer from that presented secret. No trusted actor string.
 * Bootstrap-once: the first Architect credential when none is active.
 * The last Architect credential cannot be revoked. No recovery bootstrap.
 * Not a /field route. Serve only looks up what Architect already stored.
 */
export function architectIssueFieldToken(input: {
  tenantId: string;
  principal: PrincipalKind;
  computerBaseDir: string;
  architectToken?: string;
}): IssuedFieldToken {
  const book = new FieldTokenBook(input.computerBaseDir);
  return book.issue({
    tenantId: input.tenantId,
    principal: input.principal,
    presented: input.architectToken,
  });
}

export function architectRevokeFieldToken(input: {
  tenantId: string;
  tokenId: string;
  computerBaseDir: string;
  architectToken?: string;
}): void {
  const book = new FieldTokenBook(input.computerBaseDir);
  book.revoke({
    tenantId: input.tenantId,
    tokenId: input.tokenId,
    presented: input.architectToken,
  });
}
