import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  adapterBindFile,
  findStoredAdapterBind,
  readTenantAdapterBinds,
  saveAdapterBindStore,
  upsertAdapterBind,
  type AdapterBindRecord,
} from "../habitat/adapter-bind.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/adapter-bind.json (HK-055 / DEC-020).
 * Same class as Architect credential / field-tokens. Shell is not Architect.
 * Field SHALL NOT bind, see, or edit. Not a /field route. Not SDK constructor options.
 * Upserts by modelId so the wizard can attach more than one model in the same file.
 */
export function architectBindAdapter(input: {
  tenantId: string;
  modelId: string;
  vendorBaseUrl?: string;
  computerBaseDir: string;
  architectToken?: string;
  allowHeldSeat?: boolean;
}): AdapterBindRecord {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new AvError("ADAPTER_BIND_REQUIRED", "Architect bind requires a model id");
  }
  const vendorBaseUrl = input.vendorBaseUrl?.trim();
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    allowHeldSeat: input.allowHeldSeat,
  });
  const record: AdapterBindRecord = {
    tenantId: input.tenantId,
    modelId,
    ...(vendorBaseUrl ? { vendorBaseUrl } : {}),
    boundBy: "architect",
    boundAt: nowIso(),
  };
  const file = adapterBindFile(input.computerBaseDir, input.tenantId);
  const store = upsertAdapterBind(readTenantAdapterBinds(input.computerBaseDir, input.tenantId), record);
  saveAdapterBindStore(file, record, store);
  return record;
}

/**
 * Admin edit of an already-bound model. Same writer and file as architectBindAdapter.
 * Refuses a modelId that is not already on adapter-bind.json — add stays on the wizard.
 */
export function architectEditAdapterBind(input: {
  tenantId: string;
  modelId: string;
  vendorBaseUrl?: string;
  computerBaseDir: string;
  architectToken?: string;
  allowHeldSeat?: boolean;
}): AdapterBindRecord {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new AvError("ADAPTER_BIND_REQUIRED", "Architect bind requires a model id");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    allowHeldSeat: input.allowHeldSeat,
  });
  const current = readTenantAdapterBinds(input.computerBaseDir, input.tenantId);
  if (!findStoredAdapterBind(current, input.tenantId, modelId)) {
    throw new AvError(
      "ADAPTER_NOT_BOUND",
      "Admin can edit a bound model only; attach a model in the wizard",
    );
  }
  return architectBindAdapter(input);
}
