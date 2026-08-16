import { AvError } from "../errors.js";
import type { HabitatKernel } from "../habitat/kernel.js";
import type { WakeResult } from "../habitat/types.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect delivers inter-agent mail (CS-018 / D10).
 * Writes tenants/{id}/mail.json then habitat.wake({ kind: "mail" }).
 * Field SHALL NOT deliver, impersonate, or send as Architect. Not a /field route.
 * Mail SHALL NOT confer authority.
 */
export async function architectDeliverMail(input: {
  tenantId: string;
  addresseeId: string;
  body: string;
  computerBaseDir: string;
  habitat: HabitatKernel;
  architectToken?: string;
}): Promise<WakeResult> {
  const addresseeId = input.addresseeId.trim();
  const body = input.body;
  if (!addresseeId) {
    throw new AvError("AGENT_NOT_FOUND", "Architect mail requires an existing addressee");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  return input.habitat.deliverMail({
    tenantId: input.tenantId,
    addresseeId,
    fromAgentId: "architect",
    body,
    deliveredBy: "architect",
  });
}
