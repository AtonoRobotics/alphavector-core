import { FailClosedError } from "../errors.js";
import { newId } from "../ids.js";
import type { AgentMail } from "./types.js";
import type { AgentStore } from "./store.js";

/**
 * Inter-agent mail. Communication only.
 * Mail does not confer authority and is ignored by the policy gateway
 * as an authorization source.
 */
export class AgentMailer {
  constructor(private readonly store: AgentStore) {}

  async send(input: {
    tenantId: string;
    fromAgentId: string;
    toAgentId: string;
    body: string;
  }): Promise<AgentMail> {
    const from = await this.store.get(input.fromAgentId);
    const to = await this.store.get(input.toAgentId);
    if (!from || from.tenantId !== input.tenantId) {
      throw new FailClosedError("MAIL_FROM_UNKNOWN", "Sender is not an agent on this tenant.");
    }
    if (!to || to.tenantId !== input.tenantId) {
      throw new FailClosedError("MAIL_TO_UNKNOWN", "Recipient is not an agent on this tenant.");
    }
    if (!from.evalPassed || !to.evalPassed) {
      throw new FailClosedError("MAIL_EVAL_REQUIRED", "Every agent still passes eval. Mail is blocked.");
    }
    const mail: AgentMail = {
      id: newId("mail"),
      tenantId: input.tenantId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      body: input.body,
      createdAt: new Date(),
    };
    await this.store.insertMail(mail);
    return mail;
  }
}

export function mailConfersAuthority(): false {
  return false;
}
