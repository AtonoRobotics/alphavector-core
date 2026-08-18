import { realpath } from "node:fs/promises";
import path from "node:path";
import { ComputerError } from "../errors.js";
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
    // Architect-written grants. Same class as cards: not a business fact, not on agent disk/.
    grantsFile: path.join(root, "grants.json"),
    // Field and Architect credentials. Same reason as secrets and cards.
    fieldTokensFile: path.join(root, "field-tokens.json"),
    // Predicate facts. Same reason as secrets, cards, and tokens.
    factsFile: path.join(root, "facts.json"),
    // Generic subject records. Same reason as facts, cards, and tokens.
    recordsFile: path.join(root, "records.json"),
    // Habitat control state. Same reason as cards: not a business fact, not on agent disk/.
    runsFile: path.join(root, "runs.json"),
    workersFile: path.join(root, "workers.json"),
    // Kernel-written worker briefs. Same class as workers.json: not on agent disk/.
    briefsDir: path.join(root, "briefs"),
    wakeLogFile: path.join(root, "wake-log.json"),
    memoryDir: path.join(root, "memory"),
    // Architect-written skill files. Same class as memory / cards: not on agent disk/.
    skillsDir: path.join(root, "skills"),
    // Habitat-written proposals. Same class as skills / memory / cards: not on agent disk/.
    // A proposal is not a skill. loadSkillFiles does not read this directory.
    proposalsDir: path.join(root, "proposals"),
    // Trailer files live on the tenant disk (bind-mounted at /home). Not a host-only tree.
    trailersDir: path.join(root, "disk", "trailers"),
    // Architect adapter bind. Same reason as field-tokens: not field UI, not on agent disk/.
    adapterBindFile: path.join(root, "adapter-bind.json"),
    // Provider credentials. Same class as field-tokens: not on bind, not on disk/, not a pack.
    adapterCredentialsFile: path.join(root, "adapter-credentials.json"),
    // Architect model router. Same class as adapter-bind: not field UI, not on disk/, not a pack.
    adapterRouterFile: path.join(root, "adapter-router.json"),
    // Architect multi-model aggregator. Same class as adapter-bind: not field UI, not on disk/, not a pack.
    adapterAggregatorFile: path.join(root, "adapter-aggregator.json"),
    // Architect- or pack-written routines. Same class as adapter-bind: not field UI, not on disk/.
    routinesFile: path.join(root, "routines.json"),
    // Habitat inter-agent mail. Same class as routines / adapter-bind: not field UI, not on disk/.
    mailFile: path.join(root, "mail.json"),
    // Architect- or habitat-written deadlines. Same class as routines / mail: not field UI, not Temporal.
    deadlinesFile: path.join(root, "deadlines.json"),
    // Architect connector bind. Same class as adapter-bind / mail: not field UI, not on disk/.
    connectorBindFile: path.join(root, "connector-bind.json"),
    // Connector credentials. Same class as adapter-credentials: not on bind, not on disk/, not a pack.
    connectorCredentialsFile: path.join(root, "connector-credentials.json"),
    // Counsel-signed brokerage bind. Same class as adapter-bind / cards: not field UI, not on disk/, not pack schema.
    brokerageFile: path.join(root, "brokerage.json"),
    // Architect deploy record. Same class as brokerage / adapter-bind: not field UI, not on disk/, not a vendor cloud.
    deployFile: path.join(root, "deploy.json"),
  };
}

export function assertSafeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..") || normalized.startsWith(".secrets")) {
    throw new Error(`Refusing path ${relPath}`);
  }
  return normalized;
}

function assertInsideDisk(diskReal: string, resolved: string): void {
  if (resolved === diskReal || resolved.startsWith(`${diskReal}${path.sep}`)) {
    return;
  }
  throw new ComputerError("PATH_ESCAPES_DISK", "Refusing path that does not stay inside the tenant disk");
}

/**
 * Containment after resolution is the control. Lexical checks are not sufficient.
 * `realpath` the candidate and require it stay inside `realpath(disk)`.
 */
export async function resolveInsideDisk(disk: string, relPath: string): Promise<string | undefined> {
  const safe = assertSafeRelPath(relPath);
  let diskReal: string;
  try {
    diskReal = await realpath(disk);
  } catch {
    throw new ComputerError("PATH_ESCAPES_DISK", "Tenant disk is not resolvable");
  }
  const joined = path.resolve(diskReal, safe);
  let resolved: string;
  try {
    resolved = await realpath(joined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ComputerError("PATH_ESCAPES_DISK", "Refusing path that does not stay inside the tenant disk");
  }
  assertInsideDisk(diskReal, resolved);
  return resolved;
}
