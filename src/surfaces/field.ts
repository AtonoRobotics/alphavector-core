import { SurfaceViolationError } from "../errors.js";
import type { CardBook } from "../auth/cards.js";
import type { DurableStore } from "../data/store.js";
import type { GrantBook } from "../grants/store.js";
import type { FieldHome } from "./types.js";

const FORBIDDEN_FIELD = [
  "model",
  "prompt",
  "temporal",
  "tool schema",
  "trust tier",
  "trust ladder",
  "skill promotion",
];

export class FieldSurface {
  constructor(
    private readonly cards: CardBook,
    private readonly store: DurableStore,
    private readonly grants: GrantBook,
  ) {}

  home(tenantId: string): FieldHome {
    return {
      journeys: this.store.journeys
        .filter((j) => j.tenantId === tenantId)
        .map((j) => ({ id: j.id, kind: j.journeyKind, objective: j.objective })),
      inbox: this.cards.fieldInbox(tenantId).map((c) => ({
        cardId: c.cardId,
        purpose: c.purpose,
        subject: c.subject,
        channel: c.channel,
      })),
      outboundLog: this.store.actions
        .filter((a) => a.tenantId === tenantId && a.status === "executed")
        .map((a) => ({ actionId: a.id, summary: `${a.actionClass} ${a.channel ?? ""}`.trim() })),
      killSwitch: { available: true },
      architectControls: [],
    };
  }

  kill(tenantId: string, reason: string): void {
    this.grants.kill({ tenantId, reason });
  }

  assertFieldSafe(text: string): void {
    const lowered = text.toLowerCase();
    for (const word of FORBIDDEN_FIELD) {
      if (lowered.includes(word)) {
        throw new SurfaceViolationError(`Field surface must not expose ${word}`);
      }
    }
  }
}
