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
    // Predicate facts. Same reason as secrets, cards, and tokens.
    factsFile: path.join(root, "facts.json"),
    // Generic subject records. Same reason as facts, cards, and tokens.
    recordsFile: path.join(root, "records.json"),
    // Habitat control state. Same reason as cards: not a business fact, not on agent disk/.
    runsFile: path.join(root, "runs.json"),
    workersFile: path.join(root, "workers.json"),
    wakeLogFile: path.join(root, "wake-log.json"),
    memoryDir: path.join(root, "memory"),
    skillsDir: path.join(root, "skills"),
    trailersDir: path.join(root, "trailers"),
    // Architect adapter bind. Same reason as field-tokens: not field UI, not on agent disk/.
    adapterBindFile: path.join(root, "adapter-bind.json"),
    // Provider credentials. Same class as field-tokens: not on bind, not on disk/, not a pack.
    adapterCredentialsFile: path.join(root, "adapter-credentials.json"),
  };
}

export function assertSafeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..") || normalized.startsWith(".secrets")) {
    throw new Error(`Refusing path ${relPath}`);
  }
  return normalized;
}
