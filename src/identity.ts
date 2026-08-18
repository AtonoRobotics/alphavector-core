/**
 * Public house name is Pyrallon. Architect Desktop is the surface placeholder only.
 * Locked 2026-08-17: Pyrallon / alphavector-core / llc.alphavector.dev.
 * Repos, packages, and bundle ids stay. Legal entity Alpha Vector LLC is off-app.
 * alphavector-re is a separate pack repository and SHALL NOT live here.
 */
export const PRODUCT = {
  appDisplay: "Pyrallon",
  package: "alphavector-core",
  bundleId: "llc.alphavector.dev",
  firstPackPackage: "alphavector-re",
} as const;

/**
 * Locked Website board hues. No gradients, no glow, no invented RGB.
 * Hold amber is metal for a held step only — not header, mark, buttons, or success.
 */
export const GLASS = {
  bone: "#F4F1EA",
  nearBlack: "#0B0B0C",
  hairline: "#2A2A2D",
  holdAmber: "#C4A574",
} as const;

export const GLASS_HUES = [GLASS.bone, GLASS.nearBlack, GLASS.hairline, GLASS.holdAmber] as const;

export const FORBIDDEN_PRODUCT_NAMES = [
  "Alpha Agent",
  "AlphaAgent",
  "Alpha Agents",
  "Alpha Agent AI",
  "Mission Control",
  "Desk",
  "Shape",
  "Director",
  "Play",
  "Plant",
  "HIL",
  "Thor",
  "Human.AI",
  "The Agency",
  "Omniflow",
  "Oracle",
  "VEYRA",
  "Agent OS",
] as const;

export function assertNotConsumerBrand(name: string): void {
  const lowered = name.trim().toLowerCase();
  if (lowered === "av dev" || lowered === "alpha vector" || lowered === "alphavector") {
    throw new Error(
      "AV Dev / alphavector-core is a development scaffold, not a consumer brand",
    );
  }
}

export function isForbiddenProductName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  return FORBIDDEN_PRODUCT_NAMES.some((n) => n.toLowerCase() === lowered);
}
