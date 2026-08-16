import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import {
  assertBrokerageRules,
  brokerageFile,
  saveBrokerageBind,
  verifyBrokerageCounselSignature,
  type BrokerageBindRecord,
} from "../habitat/brokerage-bind.js";
import type { TrustAnchors } from "../packs/signing.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/brokerage.json (DEC-020).
 * Same class as adapter-bind / connector-bind / cards. Shell is not Architect.
 * Field SHALL NOT bind, see, or edit. Not a /field route. Not pack schema.
 * Counsel must have signed the rules against configured trust anchors.
 */
export function architectWriteBrokerage(input: {
  tenantId: string;
  rules: unknown;
  counselSignature: string;
  computerBaseDir: string;
  architectToken?: string;
  anchors: TrustAnchors;
}): BrokerageBindRecord {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new AvError("BROKERAGE_UNBOUND", "Architect brokerage write requires a tenant id");
  }
  const counselSignature = input.counselSignature.trim();
  if (!counselSignature) {
    throw new AvError(
      "BROKERAGE_UNBOUND",
      "Brokerage bind is unsigned or incomplete; Architect must bind counsel-signed rules",
    );
  }
  const rules = assertBrokerageRules(input.rules);
  requireArchitect(tenantId, input.computerBaseDir, input.architectToken);
  const record: BrokerageBindRecord = {
    tenantId,
    rules,
    boundBy: "architect",
    boundAt: nowIso(),
    signatures: { counselEval: counselSignature },
  };
  verifyBrokerageCounselSignature(record, input.anchors);
  saveBrokerageBind(brokerageFile(input.computerBaseDir, tenantId), record);
  return record;
}
