import { computerRoot } from "../computer/paths.js";
import { AvError, SurfaceViolationError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { LoadedPack } from "../packs/types.js";
import { loadCardStore, saveCardStore } from "./card-store.js";
import type { AuthorizationCard, CardKind, FieldCardView, PendingProgressRecord } from "./types.js";

/**
 * Authorization cards. Optional computerBaseDir persists on the tenant computer
 * core owns — beside the bind-mounted disk, never inside /home and never in a pack.
 */
export class CardBook {
  private readonly cards = new Map<string, AuthorizationCard>();
  private readonly pending = new Map<string, PendingProgressRecord>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

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
    this.ensure(input.tenantId);
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
    this.persist(input.tenantId);
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
    this.ensure(tenantId);
    return [...this.cards.values()]
      .filter((c) => c.tenantId === tenantId && c.kind === "owner_instance" && c.status === "pending")
      .map((c) => this.fieldView(c));
  }

  resolve(input: { cardId: string; decision: "approved" | "denied"; actor: string }): AuthorizationCard {
    const card = this.requireCard(input.cardId);
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
    this.persist(card.tenantId);
    return next;
  }

  get(cardId: string): AuthorizationCard | undefined {
    return this.cards.get(cardId);
  }

  /** Deny is terminal. The same action must not be silently reformulated. */
  wasDenied(tenantId: string, agentId: string, actionClass: string, subject: string, channel: string): boolean {
    this.ensure(tenantId);
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

  hydrateTenant(tenantId: string): void {
    this.ensure(tenantId);
  }

  setPending(tenantId: string, cardId: string, record: PendingProgressRecord): void {
    this.ensure(tenantId);
    this.pending.set(cardId, record);
    this.persist(tenantId);
  }

  getPending(tenantId: string, cardId: string): PendingProgressRecord | undefined {
    this.ensure(tenantId);
    return this.pending.get(cardId);
  }

  clearPending(tenantId: string, cardId: string): void {
    this.ensure(tenantId);
    this.pending.delete(cardId);
    this.persist(tenantId);
  }

  listPending(tenantId: string): Array<{ cardId: string; record: PendingProgressRecord }> {
    this.ensure(tenantId);
    return [...this.pending.entries()]
      .filter(([cardId]) => this.cards.get(cardId)?.tenantId === tenantId)
      .map(([cardId, record]) => ({ cardId, record }));
  }

  private requireCard(cardId: string): AuthorizationCard {
    const card = this.cards.get(cardId);
    if (!card) throw new AvError("CARD_NOT_FOUND", `Unknown card ${cardId}`);
    return card;
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadCardStore(this.fileFor(tenantId));
      for (const card of store.cards) this.cards.set(card.cardId, card);
      for (const [cardId, record] of Object.entries(store.pending)) {
        this.pending.set(cardId, record);
      }
    } catch (err) {
      const closed =
        err instanceof AvError
          ? err
          : new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
      this.corrupt.set(tenantId, closed);
      throw closed;
    }
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    const cards = [...this.cards.values()].filter((c) => c.tenantId === tenantId);
    const pending: Record<string, PendingProgressRecord> = {};
    for (const [cardId, record] of this.pending) {
      if (this.cards.get(cardId)?.tenantId === tenantId) pending[cardId] = record;
    }
    saveCardStore(this.fileFor(tenantId), { cards, pending });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).cardsFile;
  }
}
