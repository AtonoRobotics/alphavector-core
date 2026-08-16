import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written adapter bind on the tenant computer (HK-055).
 * Same class as Architect credential / field-tokens: core-owned, beside disk/,
 * never inside the bind-mounted /home, never a field file, never a createDeepAgent option.
 */
export interface AdapterBindRecord {
  tenantId: string;
  modelId: string;
  boundBy: "architect";
  boundAt: string;
}

const CREDENTIAL_KEYS = ["apiKey", "secret", "credential", "token", "password"] as const;

/**
 * Load tenants/{id}/adapter-bind.json. Missing file → unbound (undefined).
 * Corrupt or incomplete JSON → refuse. Do not invent a model.
 */
export function loadAdapterBind(file: string): AdapterBindRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("ADAPTER_BIND_CORRUPT", "Adapter bind is corrupt; refusing to invent a model");
  }
  if (raw === undefined) return undefined;
  return parseBind(raw);
}

export function saveAdapterBind(file: string, record: AdapterBindRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

export function adapterBindFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).adapterBindFile;
}

export function readTenantAdapterBind(
  computerBaseDir: string | undefined,
  tenantId: string,
): AdapterBindRecord | undefined {
  if (!computerBaseDir) return undefined;
  return loadAdapterBind(adapterBindFile(computerBaseDir, tenantId));
}

function parseBind(raw: unknown): AdapterBindRecord {
  if (!isRecord(raw)) {
    throw new AvError("ADAPTER_BIND_CORRUPT", "Adapter bind is corrupt; refusing to invent a model");
  }
  for (const key of CREDENTIAL_KEYS) {
    if (key in raw) {
      throw new AvError(
        "ADAPTER_BIND_CORRUPT",
        "Provider credentials SHALL NOT live on adapter-bind.json",
      );
    }
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.modelId !== "string" ||
    !raw.modelId.trim() ||
    raw.boundBy !== "architect" ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt
  ) {
    throw new AvError("ADAPTER_BIND_CORRUPT", "Adapter bind is corrupt; refusing to invent a model");
  }
  return {
    tenantId: raw.tenantId,
    modelId: raw.modelId.trim(),
    boundBy: "architect",
    boundAt: raw.boundAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
