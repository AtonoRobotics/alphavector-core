import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  adapterBindFile,
  saveAdapterBind,
  type AdapterBindRecord,
} from "../habitat/adapter-bind.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/adapter-bind.json (HK-055 / DEC-020).
 * Same class as Architect credential / field-tokens. Shell is not Architect.
 * Field SHALL NOT bind, see, or edit. Not a /field route. Not SDK constructor options.
 */
export function architectBindAdapter(input: {
  tenantId: string;
  modelId: string;
  vendorBaseUrl?: string;
  computerBaseDir: string;
  architectToken?: string;
}): AdapterBindRecord {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new AvError("ADAPTER_BIND_REQUIRED", "Architect bind requires a model id");
  }
  const vendorBaseUrl = input.vendorBaseUrl?.trim();
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const record: AdapterBindRecord = {
    tenantId: input.tenantId,
    modelId,
    ...(vendorBaseUrl ? { vendorBaseUrl } : {}),
    boundBy: "architect",
    boundAt: nowIso(),
  };
  saveAdapterBind(adapterBindFile(input.computerBaseDir, input.tenantId), record);
  return record;
}
