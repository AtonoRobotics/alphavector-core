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
  /** Hosted-model base URL. Same class as modelId. Not a credential. Not field-writable. */
  vendorBaseUrl?: string;
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

export interface TenantAdapterBindStore {
  models: AdapterBindRecord[];
}

export function saveAdapterBind(file: string, record: AdapterBindRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

/**
 * Same adapter-bind.json as saveAdapterBind. Latest stay at the top level so
 * loadAdapterBind / the kernel keep reading one live record. models[] is the
 * Architect-bound set when more than one model is attached.
 */
export function saveAdapterBindStore(file: string, latest: AdapterBindRecord, store: TenantAdapterBindStore): void {
  writeJsonAtomic(file, { ...latest, models: store.models });
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

export function loadAdapterBindStore(file: string): TenantAdapterBindStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("ADAPTER_BIND_CORRUPT", "Adapter bind is corrupt; refusing to invent a model");
  }
  if (raw === undefined) return { models: [] };
  return parseStore(raw);
}

export function readTenantAdapterBinds(
  computerBaseDir: string | undefined,
  tenantId: string,
): TenantAdapterBindStore {
  if (!computerBaseDir) return { models: [] };
  return loadAdapterBindStore(adapterBindFile(computerBaseDir, tenantId));
}

export function findStoredAdapterBind(
  store: TenantAdapterBindStore,
  tenantId: string,
  modelId: string,
): AdapterBindRecord | undefined {
  return store.models.find((row) => row.modelId === modelId && row.tenantId === tenantId);
}

export function upsertAdapterBind(
  store: TenantAdapterBindStore,
  record: AdapterBindRecord,
): TenantAdapterBindStore {
  const next = store.models.filter(
    (row) => !(row.modelId === record.modelId && row.tenantId === record.tenantId),
  );
  next.push(record);
  return { models: next };
}

function parseStore(raw: unknown): TenantAdapterBindStore {
  if (!isRecord(raw)) {
    throw new AvError("ADAPTER_BIND_CORRUPT", "Adapter bind is corrupt; refusing to invent a model");
  }
  if (Array.isArray(raw.models)) {
    return { models: raw.models.map(parseBind) };
  }
  return { models: [parseBind(raw)] };
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
  let vendorBaseUrl: string | undefined;
  if ("vendorBaseUrl" in raw) {
    if (typeof raw.vendorBaseUrl !== "string") {
      throw new AvError("ADAPTER_BIND_CORRUPT", "Adapter bind is corrupt; refusing to invent a model");
    }
    const trimmed = raw.vendorBaseUrl.trim();
    if (trimmed) vendorBaseUrl = trimmed;
  }
  return {
    tenantId: raw.tenantId,
    modelId: raw.modelId.trim(),
    ...(vendorBaseUrl ? { vendorBaseUrl } : {}),
    boundBy: "architect",
    boundAt: raw.boundAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
