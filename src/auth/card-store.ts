import { chmodSync } from "node:fs";
import type { Lifecycle } from "../data/types.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { AuthorizationCard, CardKind, CardStatus, PendingProgressRecord } from "./types.js";

export interface TenantCardStore {
  cards: AuthorizationCard[];
  pending: Record<string, PendingProgressRecord>;
}

const KINDS: ReadonlySet<string> = new Set(["owner_instance", "architect_admin"]);
const STATUSES: ReadonlySet<string> = new Set(["pending", "approved", "denied"]);
const LIFECYCLES: ReadonlySet<string> = new Set(["active", "superseded", "deleted", "held"]);
const JOURNEY_STATUSES: ReadonlySet<string> = new Set(["open", "paused", "closed"]);

/**
 * Load the tenant card file. Missing file → empty store (no invented cards).
 * Corrupt or incomplete JSON → refuse. Do not reconstruct a card from guesswork.
 */
export function loadCardStore(file: string): TenantCardStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  if (raw === undefined) return { cards: [], pending: {} };
  return parseStore(raw);
}

export function saveCardStore(file: string, store: TenantCardStore): void {
  writeJsonAtomic(file, store);
  chmodSync(file, 0o600);
}

function parseStore(raw: unknown): TenantCardStore {
  if (!isRecord(raw) || !Array.isArray(raw.cards)) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  const cards = raw.cards.map(parseCard);
  const pending = parsePending(raw.pending, cards);
  return { cards, pending };
}

function parseCard(raw: unknown): AuthorizationCard {
  if (!isRecord(raw)) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  const lang = raw.fieldLanguage;
  if (
    typeof raw.cardId !== "string" ||
    !raw.cardId ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    !isKind(raw.kind) ||
    !isStatus(raw.status) ||
    typeof raw.actionClass !== "string" ||
    typeof raw.agentId !== "string" ||
    typeof raw.purpose !== "string" ||
    typeof raw.subject !== "string" ||
    typeof raw.channel !== "string" ||
    typeof raw.createdAt !== "string" ||
    !isRecord(lang) ||
    typeof lang.purpose !== "string" ||
    typeof lang.subject !== "string" ||
    typeof lang.channel !== "string" ||
    typeof lang.approve !== "string" ||
    typeof lang.deny !== "string"
  ) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  const card: AuthorizationCard = {
    cardId: raw.cardId,
    tenantId: raw.tenantId,
    kind: raw.kind,
    status: raw.status,
    actionClass: raw.actionClass,
    agentId: raw.agentId,
    purpose: raw.purpose,
    subject: raw.subject,
    channel: raw.channel,
    fieldLanguage: {
      purpose: lang.purpose,
      subject: lang.subject,
      channel: lang.channel,
      approve: lang.approve,
      deny: lang.deny,
    },
    createdAt: raw.createdAt,
  };
  if (typeof raw.resolvedAt === "string") card.resolvedAt = raw.resolvedAt;
  if (typeof raw.resolvedBy === "string") card.resolvedBy = raw.resolvedBy;
  return card;
}

function parsePending(
  raw: unknown,
  cards: AuthorizationCard[],
): Record<string, PendingProgressRecord> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  const known = new Set(cards.map((c) => c.cardId));
  const pending: Record<string, PendingProgressRecord> = {};
  for (const [cardId, value] of Object.entries(raw)) {
    if (!known.has(cardId)) {
      throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
    }
    pending[cardId] = parsePendingRecord(cardId, value);
  }
  return pending;
}

function parsePendingRecord(cardId: string, raw: unknown): PendingProgressRecord {
  if (!isRecord(raw)) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  const journey = raw.journey;
  if (
    typeof raw.journeyId !== "string" ||
    !raw.journeyId ||
    typeof raw.actionClass !== "string" ||
    !raw.actionClass ||
    typeof raw.agentId !== "string" ||
    !raw.agentId ||
    !isRecord(journey) ||
    typeof journey.id !== "string" ||
    journey.id !== raw.journeyId ||
    typeof journey.tenantId !== "string" ||
    typeof journey.journeyKind !== "string" ||
    typeof journey.objective !== "string" ||
    typeof journey.status !== "string" ||
    !JOURNEY_STATUSES.has(journey.status) ||
    typeof journey.version !== "number" ||
    typeof journey.createdAt !== "string" ||
    typeof journey.updatedAt !== "string" ||
    typeof journey.sourceLineage !== "string" ||
    typeof journey.lifecycle !== "string" ||
    !LIFECYCLES.has(journey.lifecycle)
  ) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  const record: PendingProgressRecord = {
    journeyId: raw.journeyId,
    actionClass: raw.actionClass,
    agentId: raw.agentId,
    journey: {
      tenantId: journey.tenantId,
      id: journey.id,
      version: journey.version,
      createdAt: journey.createdAt,
      updatedAt: journey.updatedAt,
      sourceLineage: journey.sourceLineage,
      lifecycle: journey.lifecycle as Lifecycle,
      journeyKind: journey.journeyKind,
      objective: journey.objective,
      status: journey.status as PendingProgressRecord["journey"]["status"],
    },
  };
  if (journey.recordId !== undefined) {
    if (typeof journey.recordId !== "string" || !journey.recordId) {
      throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
    }
    record.journey.recordId = journey.recordId;
  }
  if (typeof raw.channel === "string") record.channel = raw.channel;
  if (typeof raw.purpose === "string") record.purpose = raw.purpose;
  if (typeof raw.subject === "string") record.subject = raw.subject;
  if (typeof raw.to === "string" && raw.to.trim()) record.to = raw.to.trim();
  if (typeof raw.body === "string" && raw.body.trim()) record.body = raw.body.trim();
  if (typeof raw.from === "string" && raw.from.trim()) record.from = raw.from.trim();
  if (cardId.length === 0) {
    throw new AvError("CARD_STORE_CORRUPT", "Card store is corrupt; refusing to invent a card");
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKind(value: unknown): value is CardKind {
  return typeof value === "string" && KINDS.has(value);
}

function isStatus(value: unknown): value is CardStatus {
  return typeof value === "string" && STATUSES.has(value);
}
