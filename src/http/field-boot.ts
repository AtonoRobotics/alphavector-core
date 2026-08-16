import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerHost } from "../computer/host.js";
import { defaultImageCacheDir } from "../computer/image.js";
import { PackLoadError } from "../errors.js";
import { DeepAgentsAdapter } from "../habitat/deep-agents.js";
import type { CognitiveAdapter } from "../habitat/types.js";
import { AlphaVectorCore } from "../kernel.js";
import type { LoadedPack, PackBinding } from "../packs/types.js";
import type { TrustAnchors } from "../packs/signing.js";
import { resolveProductTrustAnchors } from "../packs/trust-anchors.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface BootFieldCoreOptions {
  /** Tenant computer root core owns. Cards, facts, and records persist beside disk/, not in a pack. */
  computerBaseDir?: string;
  /**
   * Cognitive adapter. Omit for the product default DeepAgentsAdapter
   * (requires an Architect bind and Architect-written provider credentials;
   * think is live HTTP to the hosted model, not a canned fixture).
   * DryStemAdapter is fixture-only — pass it explicitly in eval / envelope tests.
   * An explicit thinkFn on DeepAgentsAdapter is the CI double, not the product default.
   */
  adapter?: CognitiveAdapter;
  /** Injectable habitat clock. Tests advance this; product uses wall time. */
  now?: () => string;
  /** Test override of the core-owned due interval. Not field-configured. */
  tickMs?: number;
  /**
   * Trust anchors the process did not generate. Tests pass a fixture keypair
   * created outside this function. Product boot resolves file or env instead.
   */
  anchors?: TrustAnchors;
  /**
   * Already-signed pack. Architect or test inject of a pack that is already signed.
   * Product boot hydrates the signed active pack from the registry and re-verifies
   * on read-back. Not a baked domain default.
   */
  binding?: PackBinding;
  /**
   * Signed pack file. Architect or test inject (`AV_PACK_PATH`).
   * Not a product boot default. Unsigned or incomplete files fail closed.
   */
  packPath?: string;
  /** Env for product anchor/pack resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function explicitPackPath(packPath: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const file = packPath ?? env.AV_PACK_PATH;
  const trimmed = file?.trim();
  return trimmed ? trimmed : undefined;
}

async function loadInjectedBinding(packPath: string): Promise<PackBinding> {
  try {
    return JSON.parse(await readFile(packPath, "utf8")) as PackBinding;
  } catch {
    throw new PackLoadError("PACK_REFUSED", "Boot pack is unreadable");
  }
}

function hydrateActivePack(core: AlphaVectorCore, tenantId: string): LoadedPack {
  try {
    return core.packs.active(tenantId);
  } catch (err) {
    if (err instanceof PackLoadError && err.code === "NO_ACTIVE_PACK") {
      throw new PackLoadError("PACK_UNSIGNED", "No signed active pack");
    }
    throw err;
  }
}

/** Boot a core with a pack signed by configured trust anchors. Architect load is internal, not a field route. */
export async function bootFieldCore(
  tenantId = "t1",
  opts: BootFieldCoreOptions = {},
): Promise<{
  core: AlphaVectorCore;
  pack: LoadedPack;
  tenantId: string;
}> {
  const env = opts.env ?? process.env;
  const anchors = opts.anchors ?? resolveProductTrustAnchors(env);
  const injectPath = explicitPackPath(opts.packPath, env);
  const stateDir = opts.computerBaseDir ? path.join(opts.computerBaseDir, "state") : undefined;
  const core = new AlphaVectorCore(
    anchors,
    stateDir,
    opts.computerBaseDir,
    { adapter: opts.adapter ?? new DeepAgentsAdapter(), now: opts.now, tickMs: opts.tickMs },
  );
  if (opts.binding) {
    const loaded = core.packs.load({ tenantId, binding: opts.binding, actor: "architect" });
    if (!loaded.ok) {
      throw new PackLoadError(loaded.code, loaded.message);
    }
  } else if (injectPath) {
    const loaded = core.packs.load({
      tenantId,
      binding: await loadInjectedBinding(injectPath),
      actor: "architect",
    });
    if (!loaded.ok) {
      throw new PackLoadError(loaded.code, loaded.message);
    }
  }
  const pack = hydrateActivePack(core, tenantId);
  if (core.agents.list(tenantId).length === 0) {
    core.agents.instantiateFromPack(pack, "architect");
  }
  core.habitat.setPack(tenantId, pack);
  if (opts.computerBaseDir) {
    const host = await ComputerHost.create({
      baseDir: opts.computerBaseDir,
      imageCacheDir: defaultImageCacheDir(),
    });
    core.computer = host;
    core.habitat.attachComputer(host);
    const status = await host.driver.status(tenantId);
    if (status?.status !== "running") {
      await host.start(tenantId);
    }
    core.habitat.startDueTicker();
  }
  return { core, pack, tenantId };
}

export function fieldLinuxPagePath(): string {
  return path.join(REPO_ROOT, "clients/field-linux/index.html");
}
