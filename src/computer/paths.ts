import path from "node:path";
import type { ComputerPaths } from "./types.js";

export function computerRoot(baseDir: string, tenantId: string): ComputerPaths {
  const root = path.join(baseDir, "tenants", tenantId);
  return {
    root,
    disk: path.join(root, "disk"),
    rootfs: path.join(root, "rootfs"),
    desktops: path.join(root, "disk", "desktops"),
    secrets: path.join(root, "disk", ".secrets"),
    imageIdFile: path.join(root, "image-id"),
  };
}

export function assertSafeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..") || normalized.startsWith(".secrets")) {
    throw new Error(`Refusing path ${relPath}`);
  }
  return normalized;
}
