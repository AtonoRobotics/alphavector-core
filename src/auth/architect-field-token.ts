import { AvError, SurfaceViolationError } from "../errors.js";
import type { PrincipalKind } from "../packs/types.js";
import { FieldTokenBook } from "./field-tokens.js";
import type { FieldTokenIssuer, IssuedFieldToken } from "./types.js";

/**
 * Architect issues and revokes tokens off the field home screen.
 * Shell access is not Architect. Present an Architect credential stored on
 * the tenant computer (FieldTokenBook / field-tokens.json).
 * Bootstrap-once: the first Architect credential when none is active.
 * Not a /field route. Serve only looks up what Architect already stored.
 */
export function architectIssueFieldToken(input: {
  tenantId: string;
  principal: PrincipalKind;
  computerBaseDir: string;
  architectToken?: string;
}): IssuedFieldToken {
  const book = new FieldTokenBook(input.computerBaseDir);
  const actor = requireArchitectIssuer(book, input.tenantId, input.architectToken, {
    bootstrap: input.principal === "architect",
  });
  return book.issue({
    tenantId: input.tenantId,
    principal: input.principal,
    actor,
  });
}

export function architectRevokeFieldToken(input: {
  tenantId: string;
  tokenId: string;
  computerBaseDir: string;
  architectToken?: string;
}): void {
  const book = new FieldTokenBook(input.computerBaseDir);
  const actor = requireArchitectIssuer(book, input.tenantId, input.architectToken, {
    bootstrap: false,
  });
  book.revoke({
    tenantId: input.tenantId,
    tokenId: input.tokenId,
    actor,
  });
}

function requireArchitectIssuer(
  book: FieldTokenBook,
  tenantId: string,
  presented: string | undefined,
  opts: { bootstrap: boolean },
): FieldTokenIssuer {
  const secret = presented?.trim() ? presented.trim() : undefined;
  if (secret) {
    const principal = book.lookup(secret, tenantId);
    if (principal === "architect") return "architect";
    if (principal === "field") {
      throw new SurfaceViolationError("A field token cannot issue or revoke");
    }
    if (principal) {
      throw new SurfaceViolationError("Only an Architect credential may issue or revoke");
    }
    throw new AvError("UNAUTHORIZED", "Unknown or revoked Architect credential");
  }
  if (opts.bootstrap && !book.hasActiveArchitect(tenantId)) {
    return "bootstrap";
  }
  throw new SurfaceViolationError("Shell is not Architect. Present an Architect credential.");
}
