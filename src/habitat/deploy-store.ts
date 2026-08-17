import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written production deploy record (DEC-020).
 * Written only after the declared host:port is listening. A file without
 * listen is not a deploy.
 * Same class as brokerage / adapter-bind: core-owned, beside disk/,
 * never inside the bind-mounted /home, never a field file, never a vendor cloud.
 * Field-serve theater (127.0.0.1 / port 0 / t1) does not write this file.
 * Parent House is not on the field glass.
 */
export interface DeployRecord {
  tenantId: string;
  host: string;
  port: number;
  packId: string;
  packVersion: string;
  computerStatus: "running";
  databaseConfigured: true;
  deployedBy: "architect";
  deployedAt: string;
}

/**
 * Load tenants/{id}/deploy.json. Missing file → no deploy (undefined).
 * Corrupt or incomplete JSON → refuse. Do not invent a live tenant.
 */
export function loadDeployRecord(file: string): DeployRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("DEPLOY_STORE_CORRUPT", "Deploy record is corrupt; refusing to invent a live tenant");
  }
  if (raw === undefined) return undefined;
  return parseDeploy(raw);
}

export function saveDeployRecord(file: string, record: DeployRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

export function deployFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).deployFile;
}

export function readTenantDeploy(
  computerBaseDir: string | undefined,
  tenantId: string,
): DeployRecord | undefined {
  if (!computerBaseDir) return undefined;
  return loadDeployRecord(deployFile(computerBaseDir, tenantId));
}

function parseDeploy(raw: unknown): DeployRecord {
  if (!isRecord(raw)) {
    throw new AvError("DEPLOY_STORE_CORRUPT", "Deploy record is corrupt; refusing to invent a live tenant");
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.host !== "string" ||
    !raw.host.trim() ||
    typeof raw.port !== "number" ||
    !Number.isInteger(raw.port) ||
    raw.port <= 0 ||
    typeof raw.packId !== "string" ||
    !raw.packId ||
    typeof raw.packVersion !== "string" ||
    !raw.packVersion ||
    raw.computerStatus !== "running" ||
    raw.databaseConfigured !== true ||
    raw.deployedBy !== "architect" ||
    typeof raw.deployedAt !== "string" ||
    !raw.deployedAt
  ) {
    throw new AvError("DEPLOY_STORE_CORRUPT", "Deploy record is corrupt; refusing to invent a live tenant");
  }
  return {
    tenantId: raw.tenantId,
    host: raw.host.trim(),
    port: raw.port,
    packId: raw.packId,
    packVersion: raw.packVersion,
    computerStatus: "running",
    databaseConfigured: true,
    deployedBy: "architect",
    deployedAt: raw.deployedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
