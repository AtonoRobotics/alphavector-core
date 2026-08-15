import { FailClosedError } from "../errors.js";
import type { LoadedPack } from "../pack/types.js";
import type { PolicyDecision } from "../policy/types.js";

export interface ConnectorDispatch {
  connectorId: string;
  payload: Record<string, unknown>;
}

/**
 * Connectors are pack-bound. Core hosts the dispatch slot.
 * Dispatch without a gateway allow is refused.
 */
export function assertConnectorAllowed(pack: LoadedPack, connectorId: string, decision: PolicyDecision): void {
  if (decision.stance !== "allow") {
    throw new FailClosedError("CONNECTOR_DENIED", decision.reason);
  }
  if (!pack.document.connectors.some((item) => item.id === connectorId)) {
    throw new FailClosedError("CONNECTOR_UNBOUND", `Connector ${connectorId} is not bound by the pack.`);
  }
}
