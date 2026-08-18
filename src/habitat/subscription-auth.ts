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
 * Named subscription official login. Core owns issuer + client when the vendor
 * publishes them (Codex CLI, grok-build). Architect never types a start URL.
 * POST {} to an Architect-typed issuer is not the product path.
 */

export type { OfficialLoginPoll, OfficialLoginPollHandle, OfficialLoginStart, NamedSubscriptionId };

export function assertNamedSubscription(providerId: string): NamedSubscriptionId {
  if (!isNamedSubscriptionId(providerId)) {
    throw new AvError(
      "SUBSCRIPTION_PROVIDER_REQUIRED",
      "Guided subscription auth is Codex Subscription, Grok Subscription, or GLM Subscription",
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
