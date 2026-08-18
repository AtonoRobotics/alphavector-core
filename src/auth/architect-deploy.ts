import path from "node:path";
import { DeployIncompleteError, PackLoadError, SurfaceViolationError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  deployFile,
  saveDeployRecord,
  type DeployRecord,
} from "../habitat/deploy-store.js";
import type { FieldHttpServer } from "../http/field-server.js";
import type { AlphaVectorCore } from "../kernel.js";
import { FilePackRegistry } from "../packs/file-registry.js";
import type { TrustAnchors } from "../packs/signing.js";
import type { LoadedPack } from "../packs/types.js";
import { requireArchitect } from "./require-architect.js";

const THEATER_TENANT = "t1";
const FIXTURE_STEM = "dry-stem";

export interface ArchitectDeployInput {
  tenantId: string;
  computerBaseDir: string;
  core: AlphaVectorCore;
  host: string;
  port: number;
  architectToken?: string;
  allowHeldSeat?: boolean;
  /** Env for DATABASE_URL. Defaults to process.env. Not a field control. */
  env?: NodeJS.ProcessEnv;
  /** Trust anchors used to re-verify the L1 registry pack. Defaults to the core loader anchors. */
  anchors?: TrustAnchors;
}

export interface ArchitectDeployResult {
  record: DeployRecord;
  /** In-process field HTTP listen on the recorded host:port. Not persisted. */
  server: FieldHttpServer;
}

/**
 * Architect-only production deploy (DEC-020).
 * Field-serve on 127.0.0.1 / port 0 / t1 is not a deploy.
 * DryStem, unsigned fixture, and test boot are not a deploy.
 * A live tenant needs a signed pack (L1 registry, re-verified), a started
 * Hull computer, and configured DATABASE_URL. Missing any is DEPLOY_INCOMPLETE.
 * Listen on the declared host:port is the deploy. Writing deploy.json
 * without listen is not a deploy. Listen failure is fail-closed and
 * leaves no record that claims live.
 * Does not stand up a vendor cloud. Parent House is not on the field glass.
 */
export async function architectDeploy(input: ArchitectDeployInput): Promise<ArchitectDeployResult> {
  const tenantId = input.tenantId.trim();
  const host = input.host.trim();
  const port = input.port;
  if (!tenantId) {
    throw new DeployIncompleteError("Tenant id is required; deploy is incomplete");
  }
  requireArchitect(tenantId, input.computerBaseDir, input.architectToken, {
    allowHeldSeat: input.allowHeldSeat,
  });
  assertNotTheater({ tenantId, host, port });
  assertNotFixtureStem(input.core.habitat.cognitiveAdapterName());

  const env = input.env ?? process.env;
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new DeployIncompleteError("DATABASE_URL is not configured; deploy is incomplete");
  }

  const pack = resolveSignedRegistryPack(input);
  const computer = input.core.computer;
  if (!computer) {
    throw new DeployIncompleteError("Hull computer is not started; deploy is incomplete");
  }
  const status = await computer.driver.status(tenantId);
  if (status?.status !== "running") {
    throw new DeployIncompleteError("Hull computer is not started; deploy is incomplete");
  }

  const server = await listenDeclaredField(input.core, pack, tenantId, host, port);
  const record: DeployRecord = {
    tenantId,
    host,
    port,
    packId: pack.binding.identity.packId,
    packVersion: pack.binding.identity.version,
    computerStatus: "running",
    databaseConfigured: true,
    deployedBy: "architect",
    deployedAt: nowIso(),
  };
  try {
    saveDeployRecord(deployFile(input.computerBaseDir, tenantId), record);
  } catch (err) {
    await server.close().catch(() => undefined);
    throw err;
  }
  return { record, server };
}

/**
 * Bind the existing field HTTP surface on the declared host:port.
 * Reuses FieldHttpServer start / card / kill. Not startFieldServe.
 * Not a vendor cloud. Theater refusals already ran.
 */
async function listenDeclaredField(
  core: AlphaVectorCore,
  pack: LoadedPack,
  tenantId: string,
  host: string,
  port: number,
): Promise<FieldHttpServer> {
  const { FieldHttpServer } = await import("../http/field-server.js");
  const server = new FieldHttpServer({ core, pack, tenantId });
  try {
    const listened = await server.listen(port, host);
    if (listened.port !== port) {
      throw new DeployIncompleteError("Field listen did not bind the declared port; deploy is incomplete");
    }
    return server;
  } catch (err) {
    await server.close().catch(() => undefined);
    if (err instanceof DeployIncompleteError) throw err;
    throw new DeployIncompleteError("Field listen failed; deploy is incomplete");
  }
}

/**
 * Field deploy is refused. Architect is the only deployer (DEC-020).
 * A field token is SURFACE_VIOLATION. Field-serve theater stays theater.
 */
export function fieldDeploy(): never {
  throw new SurfaceViolationError("Field cannot deploy; Architect is the only deployer");
}

/** Loopback, ephemeral port, or default t1 is field-serve theater, not a deploy. */
export function isFieldServeTheater(input: { tenantId: string; host: string; port: number }): boolean {
  return (
    isTheaterTenant(input.tenantId) || isLoopbackHost(input.host) || isEphemeralPort(input.port)
  );
}

function assertNotTheater(input: { tenantId: string; host: string; port: number }): void {
  if (isTheaterTenant(input.tenantId)) {
    throw new DeployIncompleteError("Default tenant t1 is not a live deploy");
  }
  if (isLoopbackHost(input.host)) {
    throw new DeployIncompleteError("Loopback field-serve is not a deploy");
  }
  if (isEphemeralPort(input.port)) {
    throw new DeployIncompleteError("Ephemeral port is not a deploy");
  }
  if (!input.host.trim()) {
    throw new DeployIncompleteError("Deploy host is required; deploy is incomplete");
  }
}

function assertNotFixtureStem(adapterName: string): void {
  if (adapterName === FIXTURE_STEM) {
    throw new DeployIncompleteError("DryStem is fixture-only; not a deploy");
  }
}

function resolveSignedRegistryPack(input: ArchitectDeployInput) {
  const stateDir = path.join(input.computerBaseDir, "state");
  const registry = new FilePackRegistry(stateDir);
  const anchors = input.anchors ?? input.core.packs.trustAnchors();
  try {
    const loaded = registry.getActive(input.tenantId.trim(), anchors);
    if (!loaded) {
      throw new DeployIncompleteError("Signed pack is missing; deploy is incomplete");
    }
    return loaded;
  } catch (err) {
    if (err instanceof DeployIncompleteError) throw err;
    if (err instanceof PackLoadError) {
      throw new DeployIncompleteError("Signed pack is missing; deploy is incomplete");
    }
    throw err;
  }
}

function isTheaterTenant(tenantId: string): boolean {
  return tenantId.trim() === THEATER_TENANT;
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "[::1]" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("127.")) return true;
  return false;
}

function isEphemeralPort(port: number): boolean {
  return !Number.isInteger(port) || port <= 0;
}
