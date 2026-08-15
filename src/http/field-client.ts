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
   * Completes one pack journey and one owner card approve against a live field API.
   * Used by the Linux client so a reviewer can finish the required path today.
   */
  async completeBuyerJourneyAndCard(): Promise<{
    journey: Journey;
    cardId: string;
    effect: NonNullable<FieldProgressResult["effect"]>;
  }> {
    const journey = await this.start("buyer", "Work this buyer journey");
    let cardId = "";
    try {
      await this.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "buyer",
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
