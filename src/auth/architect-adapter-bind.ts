import { FieldTokenBook } from "./field-tokens.js";
import { AvError, SurfaceViolationError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  adapterBindFile,
  saveAdapterBind,
  type AdapterBindRecord,
} from "../habitat/adapter-bind.js";

/**
 * Architect writes tenants/{id}/adapter-bind.json (HK-055 / DEC-020).
 * Same class as Architect credential / field-tokens. Shell is not Architect.
 * Field SHALL NOT bind, see, or edit. Not a /field route. Not SDK constructor options.
 */
export function architectBindAdapter(input: {
  tenantId: string;
  modelId: string;
  computerBaseDir: string;
  architectToken?: string;
}): AdapterBindRecord {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new AvError("ADAPTER_BIND_REQUIRED", "Architect bind requires a model id");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const record: AdapterBindRecord = {
    tenantId: input.tenantId,
    modelId,
    boundBy: "architect",
    boundAt: nowIso(),
  };
  saveAdapterBind(adapterBindFile(input.computerBaseDir, input.tenantId), record);
  return record;
}

function requireArchitect(
  tenantId: string,
  computerBaseDir: string,
  presented: string | undefined,
): void {
  const book = new FieldTokenBook(computerBaseDir);
  const secret = presented?.trim() ? presented.trim() : undefined;
  if (!secret) {
    throw new SurfaceViolationError("Shell is not Architect. Present an Architect credential.");
  }
  const principal = book.lookup(secret, tenantId);
  if (principal === "architect") return;
  if (principal === "field") {
    throw new SurfaceViolationError("A field token cannot bind, see, or edit the adapter");
  }
  if (principal) {
    throw new SurfaceViolationError("Only an Architect credential may write adapter-bind.json");
  }
  throw new AvError("UNAUTHORIZED", "Unknown or revoked Architect credential");
}
