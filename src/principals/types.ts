/**
 * DEC-021: two principals. The OS does not smash surfaces together.
 */
export const PRINCIPAL_KINDS = ["architect", "field_user"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface Principal {
  id: string;
  tenantId: string;
  kind: PrincipalKind;
  displayName: string;
}

export function isArchitect(principal: Principal): boolean {
  return principal.kind === "architect";
}

export function isFieldUser(principal: Principal): boolean {
  return principal.kind === "field_user";
}
