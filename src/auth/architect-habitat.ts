import type { ArchitectHabitatSeat } from "../surfaces/types.js";
import type { ArchitectSurface } from "../surfaces/architect.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect sits in the habitat (HK-082). Credential-gated read of live state:
 * org, open runs, workers, grants, eval, isolation. Not a write-* verb.
 * HTTP GET `/architect/habitat` may serve the habitat wizard; writes go through
 * architectBind* / architectWrite* — not this function.
 * Shell is not Architect. A field token is SURFACE_VIOLATION.
 */
export function architectSit(input: {
  tenantId: string;
  computerBaseDir: string;
  surface: ArchitectSurface;
  architectToken?: string;
}): ArchitectHabitatSeat {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  return input.surface.sit(input.tenantId);
}
