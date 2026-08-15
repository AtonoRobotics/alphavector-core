import { FailClosedError } from "../errors.js";
import type { Principal } from "./types.js";
import { isArchitect, isFieldUser } from "./types.js";

export type Surface = "field" | "ask" | "architect";

export function assertSurfaceAccess(principal: Principal, surface: Surface): void {
  if (surface === "architect" && !isArchitect(principal)) {
    throw new FailClosedError(
      "SURFACE_ARCHITECT_DENIED",
      "Architect surface is off the field path. Field users cannot open it.",
    );
  }
  if ((surface === "field" || surface === "ask") && !isFieldUser(principal) && !isArchitect(principal)) {
    throw new FailClosedError("SURFACE_DENIED", "Unknown principal cannot use this surface.");
  }
}

export function assertArchitect(principal: Principal, action: string): void {
  if (!isArchitect(principal)) {
    throw new FailClosedError(
      "ARCHITECT_ONLY",
      `Field users cannot ${action}. Architect or the loaded pack authors this.`,
    );
  }
}

export function assertSameTenant(principal: Principal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new FailClosedError("TENANT_MISMATCH", "Principal does not belong to this tenant.");
  }
}
