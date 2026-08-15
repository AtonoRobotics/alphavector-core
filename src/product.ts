/**
 * Product identity for the AV Dev operating system.
 * This is not a consumer house name and not a vertical application.
 */
export const PRODUCT = {
  displayName: "AV Dev",
  package: "alphavector-core",
  bundle: "llc.alphavector.dev",
  computerImage: "llc.alphavector.dev/computer",
  computerImageVersion: "0.1.0",
} as const;

export type ProductIdentity = typeof PRODUCT;

export const NOT_THIS_PRODUCT = [
  "Mission Control",
  "alphavector-re",
  "Desk",
  "Shape",
  "Director",
  "Play",
  "Plant",
  "HIL",
  "Thor",
  "Pad",
  "Nexus",
  "GUIDO",
  "FIDO",
  "Uplink",
] as const;
