import path from "node:path";
import type { ComputerPaths } from "./types.js";

export function computerRoot(baseDir: string, tenantId: string): ComputerPaths {
  const root = path.join(baseDir, "tenants", tenantId);
  return {
    root,
    disk: path.join(root, "disk"),
    rootfs: path.join(root, "rootfs"),
    desktops: path.join(root, "disk", "desktops"),
    // Secrets live beside the disk, never inside the bind-mounted /home.
    secrets: path.join(root, "secrets"),
    secretOverlay: path.join(root, "secret-overlay"),
    imageIdFile: path.join(root, "image-id"),
    egressFile: path.join(root, "egress.json"),
    // Cards are authorization state. Same reason as secrets: agents share disk/.
    cardsFile: path.join(root, "cards.json"),
    // Field and Architect credentials. Same reason as secrets and cards.
    fieldTokensFile: path.join(root, "field-tokens.json"),
  };
}

export function assertSafeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..") || normalized.startsWith(".secrets")) {
    throw new Error(`Refusing path ${relPath}`);
  }
  return normalized;
}
