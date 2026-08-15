import { AvError, SurfaceViolationError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { LoadedPack } from "../packs/types.js";
import type { AuthorizationCard, CardKind, FieldCardView } from "./types.js";

export class CardBook {
  private readonly cards = new Map<string, AuthorizationCard>();

  issue(input: {
    tenantId: string;
    kind: CardKind;
    actionClass: string;
    agentId: string;
    purpose: string;
    subject: string;
    channel: string;
    pack: LoadedPack;
  }): AuthorizationCard {
    const map = input.pack.binding.fieldLanguageMap;
    const card: AuthorizationCard = {
      cardId: newId("card"),
      tenantId: input.tenantId,
      kind: input.kind,
      status: "pending",
      actionClass: input.actionClass,
      agentId: input.agentId,
      purpose: input.purpose,
      subject: input.subject,
      channel: input.channel,
      fieldLanguage: {
        purpose: map[`purpose.${input.purpose}`] ?? input.purpose,
        subject: map[`subject.${input.subject}`] ?? input.subject,
        channel: map[`channel.${input.channel}`] ?? input.channel,
        approve: map.approve ?? "Approve",
        deny: map.deny ?? "Deny",
      },
      createdAt: nowIso(),
    };
    this.cards.set(card.cardId, card);
    return card;
  }

  fieldView(card: AuthorizationCard): FieldCardView {
    if (card.kind !== "owner_instance") {
      throw new SurfaceViolationError("Architect/admin cards SHALL NOT appear on the field surface");
    }
    return {
      cardId: card.cardId,
      purpose: card.fieldLanguage.purpose,
      subject: card.fieldLanguage.subject,
      channel: card.fieldLanguage.channel,
      approve: card.fieldLanguage.approve,
      deny: card.fieldLanguage.deny,
    };
  }

  fieldInbox(tenantId: string): FieldCardView[] {
    return [...this.cards.values()]
      .filter((c) => c.tenantId === tenantId && c.kind === "owner_instance" && c.status === "pending")
      .map((c) => this.fieldView(c));
  }

  resolve(input: { cardId: string; decision: "approved" | "denied"; actor: string }): AuthorizationCard {
    const card = this.cards.get(input.cardId);
    if (!card) throw new AvError("CARD_NOT_FOUND", `Unknown card ${input.cardId}`);
    if (card.status !== "pending") {
      throw new AvError("CARD_NOT_PENDING", "Card already resolved");
    }
    const next: AuthorizationCard = {
      ...card,
      status: input.decision,
      resolvedAt: nowIso(),
      resolvedBy: input.actor,
    };
    this.cards.set(card.cardId, next);
    return next;
  }

  get(cardId: string): AuthorizationCard | undefined {
    return this.cards.get(cardId);
  }

  /** Deny is terminal. The same action must not be silently reformulated. */
  wasDenied(tenantId: string, agentId: string, actionClass: string, subject: string, channel: string): boolean {
    return [...this.cards.values()].some(
      (c) =>
        c.tenantId === tenantId &&
        c.agentId === agentId &&
        c.actionClass === actionClass &&
        c.subject === subject &&
        c.channel === channel &&
        c.status === "denied",
    );
  }
}
