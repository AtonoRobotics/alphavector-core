import type { PrincipalKind } from "../packs/types.js";
import { FieldTokenBook } from "./field-tokens.js";
import type { IssuedFieldToken } from "./types.js";

/**
 * Architect issues and revokes field tokens off the field home screen.
 * Not a /field route. Serve only looks up what Architect already stored.
 */
export function architectIssueFieldToken(input: {
  tenantId: string;
  principal: PrincipalKind;
  computerBaseDir: string;
}): IssuedFieldToken {
  return new FieldTokenBook(input.computerBaseDir).issue({
    tenantId: input.tenantId,
    principal: input.principal,
    actor: "architect",
  });
}

export function architectRevokeFieldToken(input: {
  tenantId: string;
  tokenId: string;
  computerBaseDir: string;
}): void {
  new FieldTokenBook(input.computerBaseDir).revoke({
    tenantId: input.tenantId,
    tokenId: input.tokenId,
    actor: "architect",
  });
}
