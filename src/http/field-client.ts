import type { FieldCardView } from "../auth/types.js";
import type { Journey } from "../data/types.js";
import type { FieldHome, FieldProgressResult } from "../surfaces/types.js";
import type { FieldApproveResult, FieldProgressBody } from "./types.js";

export class FieldHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly cardId?: string;

  constructor(status: number, code: string, message: string, cardId?: string) {
    super(message);
    this.name = "FieldHttpError";
    this.status = status;
    this.code = code;
    this.cardId = cardId;
  }
}

/** Linux-runnable client for the field HTTP API. Same routes as the iOS target. */
export class FieldClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  home(): Promise<FieldHome> {
    return this.request<FieldHome>("GET", "/field/home");
  }

  start(journeyKind: string, objective: string): Promise<Journey> {
    return this.request<Journey>("POST", "/field/journeys", { journeyKind, objective });
  }

  progress(journeyId: string, body: FieldProgressBody = {}): Promise<FieldProgressResult> {
    return this.request<FieldProgressResult>("POST", `/field/journeys/${encodeURIComponent(journeyId)}/progress`, body);
  }

  cards(): Promise<FieldCardView[]> {
    return this.request<{ cards: FieldCardView[] }>("GET", "/field/cards").then((r) => r.cards);
  }

  approve(cardId: string): Promise<FieldApproveResult> {
    return this.request<FieldApproveResult>("POST", `/field/cards/${encodeURIComponent(cardId)}/approve`);
  }

  deny(cardId: string): Promise<{ cardId: string; status: string }> {
    return this.request<{ cardId: string; status: string }>(
      "POST",
      `/field/cards/${encodeURIComponent(cardId)}/deny`,
    );
  }

  ask(text: string, actionClass: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("POST", "/field/ask", { text, actionClass });
  }

  /** Issues an owner_instance card. Persist happens only after approve. */
  record(id: string): Promise<{ id: string; present: boolean }> {
    return this.request("POST", "/field/facts", { id });
  }

  /** Issues an owner_instance card. Retract happens only after approve. */
  retract(id: string): Promise<{ id: string; present: boolean }> {
    return this.request("POST", "/field/facts/retract", { id });
  }

  /**
   * Page path: POST /field/facts or /field/facts/retract, then approve the
   * owner_instance card. Persist happens only after approve.
   */
  async requestFactCard(id: string, op: "record" | "retract" = "record"): Promise<string> {
    try {
      if (op === "record") await this.record(id);
      else await this.retract(id);
      throw new Error("expected authorization card before fact write");
    } catch (err) {
      if (!(err instanceof FieldHttpError) || err.code !== "AUTHORIZATION_REQUIRED" || !err.cardId) {
        throw err;
      }
      return err.cardId;
    }
  }

  /**
   * Same routes the Linux page uses: record → card → approve → retract → card → approve.
   */
  async completeFactRecordAndRetract(id: string): Promise<{
    recordCardId: string;
    retractCardId: string;
    recorded: NonNullable<FieldApproveResult["fact"]>;
    retracted: NonNullable<FieldApproveResult["fact"]>;
  }> {
    const recordCardId = await this.requestFactCard(id, "record");
    const recorded = await this.approve(recordCardId);
    if (!recorded.fact?.present) {
      throw new Error("fact record approve did not persist");
    }
    const retractCardId = await this.requestFactCard(id, "retract");
    const retracted = await this.approve(retractCardId);
    if (!retracted.fact || retracted.fact.present) {
      throw new Error("fact retract approve did not remove");
    }
    return { recordCardId, retractCardId, recorded: recorded.fact, retracted: retracted.fact };
  }

  /**
   * Record a generic fact through the existing card path: request → approve → persist.
   * Not a back door — same routes as the Linux page.
   */
  async recordApprovedFact(id: string): Promise<NonNullable<FieldApproveResult["fact"]>> {
    const cardId = await this.requestFactCard(id, "record");
    const approved = await this.approve(cardId);
    if (!approved.fact?.present) {
      throw new Error(`fact record approve did not persist ${id}`);
    }
    return approved.fact;
  }

  /**
   * Field action on a pack journey kind. Issues an owner_instance card for
   * `journey.{kindId}` via POST /field/facts. Persist happens only after approve.
   * Does not start the journey and does not record purpose/PREFERS/AVOIDS facts.
   */
  open(kindId: string): Promise<string> {
    return this.requestFactCard(this.journeyFactId(kindId));
  }

  /** Same Open path the Linux page uses, then approve. For tests/demo only. */
  openApproved(kindId: string): Promise<NonNullable<FieldApproveResult["fact"]>> {
    return this.recordApprovedFact(this.journeyFactId(kindId));
  }

  /** Generic journey slot from a pack kind id. Not an RE column. */
  journeyFactId(kindId: string): string {
    return `journey.${kindId}`;
  }

  /**
   * Completes one pack journey and one owner card approve against a live field API.
   * Used by the Linux client so a reviewer can finish the required path today.
   * Opens the buyer kind through the Open path, then records purpose.follow-up
   * separately before communicate. Does not mint tokens or skip the card.
   */
  async completeBuyerJourneyAndCard(): Promise<{
    journey: Journey;
    cardId: string;
    effect: NonNullable<FieldProgressResult["effect"]>;
  }> {
    const home = await this.home();
    const kind = home.journeyKinds[0];
    if (!kind) throw new Error("loaded pack has no journey kinds");
    await this.openApproved(kind.id);
    await this.recordApprovedFact("purpose.follow-up");
    const journey = await this.start(kind.id, `Work this ${kind.label} journey`);
    let cardId = "";
    try {
      await this.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: kind.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      if (!(err instanceof FieldHttpError) || err.code !== "AUTHORIZATION_REQUIRED" || !err.cardId) {
        throw err;
      }
      cardId = err.cardId;
    }
    const approved = await this.approve(cardId);
    if (!approved.effect?.executed) {
      throw new Error("card approve did not execute");
    }
    return { journey, cardId, effect: approved.effect };
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new FieldHttpError(
        res.status,
        typeof parsed.error === "string" ? parsed.error : "HTTP_ERROR",
        typeof parsed.message === "string" ? parsed.message : res.statusText,
        typeof parsed.cardId === "string" ? parsed.cardId : undefined,
      );
    }
    return parsed as T;
  }
}
