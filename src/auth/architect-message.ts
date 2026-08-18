import type { HabitatKernel } from "../habitat/kernel.js";
import type { WakeResult } from "../habitat/types.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect message is a kernel wake (HK-011). Not sit().
 * habitat.wake({ kind: "architect_message" }) loads the orchestrator, or the
 * addressed role-agent when addresseeId is present. Field SHALL NOT issue it.
 * Shell is not Architect.
 */
export async function architectDeliverMessage(input: {
  tenantId: string;
  body: string;
  addresseeId?: string;
  computerBaseDir: string;
  habitat: HabitatKernel;
  architectToken?: string;
  sessionVerified?: boolean;
}): Promise<WakeResult> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    sessionVerified: input.sessionVerified,
  });
  return input.habitat.deliverArchitectMessage({
    tenantId: input.tenantId,
    body: input.body,
    addresseeId: input.addresseeId,
  });
}
