import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";

/**
 * Architect-written multi-model aggregator on the tenant computer.
 * Same class as adapter-bind: core-owned, beside disk/, never a field file,
 * never a pack type, never a hardcoded ensemble.
 * Combine is Architect-entered (gather, vote, pick, or another Architect rule).
 */
export interface AdapterAggregatorRecord {
  tenantId: string;
  combine: string;
  boundBy: "architect";
  boundAt: string;
}

/**
 * Load tenants/{id}/adapter-aggregator.json. Missing file → undefined.
 * Corrupt or incomplete JSON → refuse. Do not invent a combine.
 */
export function loadAdapterAggregator(file: string): AdapterAggregatorRecord | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError(
      "ADAPTER_AGGREGATOR_CORRUPT",
      "Adapter aggregator is corrupt; refusing to invent a combine",
    );
  }
  if (raw === undefined) return undefined;
  return parseAggregator(raw);
}

export function saveAdapterAggregator(file: string, record: AdapterAggregatorRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

export function adapterAggregatorFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).adapterAggregatorFile;
}

export function readTenantAdapterAggregator(
  computerBaseDir: string | undefined,
  tenantId: string,
): AdapterAggregatorRecord | undefined {
  if (!computerBaseDir) return undefined;
  return loadAdapterAggregator(adapterAggregatorFile(computerBaseDir, tenantId));
}

function parseAggregator(raw: unknown): AdapterAggregatorRecord {
  if (!isRecord(raw)) {
    throw new AvError(
      "ADAPTER_AGGREGATOR_CORRUPT",
      "Adapter aggregator is corrupt; refusing to invent a combine",
    );
  }
  for (const key of ["apiKey", "secret", "credential", "token", "password"] as const) {
    if (key in raw) {
      throw new AvError(
        "ADAPTER_AGGREGATOR_CORRUPT",
        "Provider credentials SHALL NOT live on adapter-aggregator.json",
      );
    }
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.combine !== "string" ||
    !raw.combine.trim() ||
    raw.boundBy !== "architect" ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt
  ) {
    throw new AvError(
      "ADAPTER_AGGREGATOR_CORRUPT",
      "Adapter aggregator is corrupt; refusing to invent a combine",
    );
  }
  return {
    tenantId: raw.tenantId,
    combine: raw.combine.trim(),
    boundBy: "architect",
    boundAt: raw.boundAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
