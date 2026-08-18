import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  adapterRouterFile,
  saveAdapterRouter,
  type AdapterRouterRecord,
} from "../habitat/adapter-router.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/adapter-router.json.
 * Same write gate as adapter-bind. Shell is not Architect.
 * Field SHALL NOT set or change the router (DEC-020).
 * Rules are Architect-entered. No hardcoded model ids, hosts, or vendor URLs.
 */
export function architectWriteAdapterRouter(input: {
  tenantId: string;
  rules: string;
  computerBaseDir: string;
  architectToken?: string;
  sessionVerified?: boolean;
}): AdapterRouterRecord {
  const rules = input.rules.trim();
  if (!rules) {
    throw new AvError("ADAPTER_ROUTER_REQUIRED", "Architect router write requires rules");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    sessionVerified: input.sessionVerified,
  });
  const record: AdapterRouterRecord = {
    tenantId: input.tenantId,
    rules,
    boundBy: "architect",
    boundAt: nowIso(),
  };
  saveAdapterRouter(adapterRouterFile(input.computerBaseDir, input.tenantId), record);
  return record;
}
