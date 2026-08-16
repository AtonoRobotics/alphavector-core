import { FieldTokenBook } from "./field-tokens.js";
import { AvError, SurfaceViolationError } from "../errors.js";

/**
 * Architect write gate. Same class as field-token issue/revoke and adapter bind.
 * Shell is not Architect. A field token cannot pass.
 */
export function requireArchitect(
  tenantId: string,
  computerBaseDir: string,
  presented: string | undefined,
): void {
  const book = new FieldTokenBook(computerBaseDir);
  const secret = presented?.trim() ? presented.trim() : undefined;
  if (!secret) {
    throw new SurfaceViolationError("Shell is not Architect. Present an Architect credential.");
  }
  const principal = book.lookup(secret, tenantId);
  if (principal === "architect") return;
  if (principal === "field") {
    throw new SurfaceViolationError(
      "A field token cannot sit in the habitat or bind, see, or edit the adapter, provider credentials, routines, mail, deadlines, connectors, skills, brokerage, or promote a proposal",
    );
  }
  if (principal) {
    throw new SurfaceViolationError(
      "Only an Architect credential may sit in the habitat or write adapter bind, provider credentials, routines, mail, deadlines, connectors, skills, brokerage, or promote a proposal",
    );
  }
  throw new AvError("UNAUTHORIZED", "Unknown or revoked Architect credential");
}
