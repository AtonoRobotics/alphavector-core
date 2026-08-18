import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  adapterAggregatorFile,
  saveAdapterAggregator,
  type AdapterAggregatorRecord,
} from "../habitat/adapter-aggregator.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/adapter-aggregator.json.
 * Same write gate as adapter-bind. Shell is not Architect.
 * Field SHALL NOT configure the aggregator (DEC-020).
 * Combine is Architect-entered. No hardcoded ensemble.
 */
export function architectWriteAdapterAggregator(input: {
  tenantId: string;
  combine: string;
  computerBaseDir: string;
  architectToken?: string;
  sessionVerified?: boolean;
}): AdapterAggregatorRecord {
  const combine = input.combine.trim();
  if (!combine) {
    throw new AvError("ADAPTER_AGGREGATOR_REQUIRED", "Architect aggregator write requires a combine");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    sessionVerified: input.sessionVerified,
  });
  const record: AdapterAggregatorRecord = {
    tenantId: input.tenantId,
    combine,
    boundBy: "architect",
    boundAt: nowIso(),
  };
  saveAdapterAggregator(adapterAggregatorFile(input.computerBaseDir, input.tenantId), record);
  return record;
}
