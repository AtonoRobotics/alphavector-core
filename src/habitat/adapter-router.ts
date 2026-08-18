import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written model router on the tenant computer.
 * Same class as adapter-bind: core-owned, beside disk/, never a field file,
 * never a pack type, never a hardcoded model id or vendor host.
 * Rules are Architect-entered (fallback order, capability/task match).
 */
export interface AdapterRouterRecord {
  tenantId: string;
  rules: string;
  boundBy: "architect";
  boundAt: string;
}

/**
 * Load tenants/{id}/adapter-router.json. Missing file → undefined.
 * Corrupt or incomplete JSON → refuse. Do not invent rules.
 */
export function loadAdapterRouter(file: string): AdapterRouterRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("ADAPTER_ROUTER_CORRUPT", "Adapter router is corrupt; refusing to invent rules");
  }
  if (raw === undefined) return undefined;
  return parseRouter(raw);
}

export function saveAdapterRouter(file: string, record: AdapterRouterRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

export function adapterRouterFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).adapterRouterFile;
}

export function readTenantAdapterRouter(
  computerBaseDir: string | undefined,
  tenantId: string,
): AdapterRouterRecord | undefined {
  if (!computerBaseDir) return undefined;
  return loadAdapterRouter(adapterRouterFile(computerBaseDir, tenantId));
}

function parseRouter(raw: unknown): AdapterRouterRecord {
  if (!isRecord(raw)) {
    throw new AvError("ADAPTER_ROUTER_CORRUPT", "Adapter router is corrupt; refusing to invent rules");
  }
  for (const key of ["apiKey", "secret", "credential", "token", "password"] as const) {
    if (key in raw) {
      throw new AvError("ADAPTER_ROUTER_CORRUPT", "Provider credentials SHALL NOT live on adapter-router.json");
    }
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.rules !== "string" ||
    !raw.rules.trim() ||
    raw.boundBy !== "architect" ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt
  ) {
    throw new AvError("ADAPTER_ROUTER_CORRUPT", "Adapter router is corrupt; refusing to invent rules");
  }
  return {
    tenantId: raw.tenantId,
    rules: raw.rules.trim(),
    boundBy: "architect",
    boundAt: raw.boundAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
