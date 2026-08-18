import { FieldTokenBook } from "./field-tokens.js";
import { AvError, SurfaceViolationError } from "../errors.js";

/**
 * Architect write gate. Same class as field-token issue/revoke and adapter bind.
 * Shell is not Architect. A field token cannot pass.
 * Habitat HTTP accepts a verified Architect credential (CLI / Bearer — not a
 * wizard paste of the deploy-held token) or a checked session cookie issued
 * after password sign-in. An open listen is not a seat.
 */
export function requireArchitect(
  tenantId: string,
  computerBaseDir: string,
  presented: string | undefined,
  opts?: { sessionVerified?: boolean },
): void {
  const book = new FieldTokenBook(computerBaseDir);
  const secret = presented?.trim() ? presented.trim() : undefined;
  if (!secret) {
    if (opts?.sessionVerified) return;
    throw new SurfaceViolationError("Shell is not Architect. Present an Architect credential.");
  }
  const principal = book.lookup(secret, tenantId);
  if (principal === "architect") return;
  if (principal === "field") {
    throw new SurfaceViolationError(
      "A field token cannot sit in the habitat, issue an architect message, or bind, see, or edit the adapter, provider credentials, router, aggregator, routines, mail, deadlines, connectors, skills, brokerage, deploy a tenant, or promote a proposal",
    );
  }
  if (principal) {
    throw new SurfaceViolationError(
      "Only an Architect credential may sit in the habitat, issue an architect message, or write adapter bind, provider credentials, router, aggregator, routines, mail, deadlines, connectors, skills, brokerage, deploy a tenant, or promote a proposal",
    );
  }
  throw new AvError("UNAUTHORIZED", "Unknown or revoked Architect credential");
}
