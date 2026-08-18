import { AvError } from "../errors.js";
import {
  isNamedSubscriptionId,
  pollOfficialSubscriptionLogin,
  startOfficialSubscriptionLogin,
  type NamedSubscriptionId,
  type OfficialLoginPoll,
  type OfficialLoginPollHandle,
  type OfficialLoginStart,
} from "./vendor-login.js";

/**
 * Codex Subscription official login. Core owns issuer + client from openai/codex.
 * Architect never types a start URL. POST {} to an Architect-typed issuer is not
 * the product path. Grok/GLM are official API-key paste, not this login.
 */

export type { OfficialLoginPoll, OfficialLoginPollHandle, OfficialLoginStart, NamedSubscriptionId };

export function assertNamedSubscription(providerId: string): NamedSubscriptionId {
  if (!isNamedSubscriptionId(providerId)) {
    throw new AvError(
      "SUBSCRIPTION_PROVIDER_REQUIRED",
      "Guided subscription auth is only Codex Subscription. Grok and GLM are labeled API key attach.",
    );
  }
  return providerId;
}

export async function startSubscriptionLogin(providerId: string): Promise<OfficialLoginStart> {
  return startOfficialSubscriptionLogin(assertNamedSubscription(providerId));
}

export async function pollSubscriptionLogin(handle: OfficialLoginPollHandle): Promise<OfficialLoginPoll> {
  return pollOfficialSubscriptionLogin(handle);
}
