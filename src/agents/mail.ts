import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { MailMessage } from "./types.js";

const AUTHORITY_PATTERNS = [
  /you are (now )?authorized/i,
  /skip (the )?(card|gateway|policy)/i,
  /grant yourself/i,
  /ignore (policy|authorization)/i,
];

export class AgentMail {
  private readonly messages: MailMessage[] = [];

  send(input: {
    tenantId: string;
    fromAgentId: string;
    toAgentId: string;
    body: string;
  }): MailMessage {
    if (input.fromAgentId === input.toAgentId) {
      throw new AvError("MAIL_INVALID", "Agent cannot mail itself as an authority channel");
    }
    const message: MailMessage = {
      messageId: newId("mail"),
      tenantId: input.tenantId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      body: input.body,
      createdAt: nowIso(),
      confersAuthority: false,
    };
    this.messages.push(message);
    return message;
  }

  inbox(tenantId: string, agentId: string): MailMessage[] {
    return this.messages.filter((m) => m.tenantId === tenantId && m.toAgentId === agentId);
  }

  /** Mail is untrusted content. It never confers authority. */
  interpret(message: MailMessage): { confersAuthority: false; authorityInstruction: boolean } {
    const authorityInstruction = AUTHORITY_PATTERNS.some((p) => p.test(message.body));
    return { confersAuthority: false, authorityInstruction };
  }
}
