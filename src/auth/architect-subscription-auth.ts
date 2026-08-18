import { AvError } from "../errors.js";
import { newId } from "../ids.js";
import {
  pollSubscriptionLogin,
  startSubscriptionLogin,
  type OfficialLoginPollHandle,
} from "../habitat/subscription-auth.js";
import { findProvider, modelIdForBind } from "../http/architect-habitat-wizard.js";
import { architectBindAdapter } from "./architect-adapter-bind.js";
import { architectWriteAdapterCredentials } from "./architect-adapter-credentials.js";
import { requireArchitect } from "./require-architect.js";

/**
 * In-flight official vendor login held by the habitat wizard. Not a second secrets plane.
 * After complete, the session is written through architectWriteAdapterCredentials.
 */
export interface SubscriptionAuthSession {
  authId: string;
  tenantId: string;
  providerId: string;
  modelId: string;
  userCode?: string;
  verificationUri: string;
  poll: OfficialLoginPollHandle;
}

export interface SubscriptionAuthHold {
  put(session: SubscriptionAuthSession): void;
  get(authId: string): SubscriptionAuthSession | undefined;
  drop(authId: string): void;
}

export class MemorySubscriptionAuthHold implements SubscriptionAuthHold {
  private readonly sessions = new Map<string, SubscriptionAuthSession>();

  put(session: SubscriptionAuthSession): void {
    this.sessions.set(session.authId, session);
  }

  get(authId: string): SubscriptionAuthSession | undefined {
    return this.sessions.get(authId);
  }

  drop(authId: string): void {
    this.sessions.delete(authId);
  }
}

export interface SubscriptionAuthStarted {
  authId: string;
  providerId: string;
  modelId: string;
  userCode?: string;
  verificationUri: string;
  status: "pending";
}

export interface SubscriptionAuthPending {
  authId: string;
  status: "authorization_pending";
}

export interface SubscriptionAuthBound {
  ok: true;
  authId: string;
  modelId: string;
  boundBy: "architect";
  status: "bound";
}

export function isSubscriptionProviderId(providerId: string): boolean {
  const provider = findProvider(providerId);
  return Boolean(provider && provider.mode === "subscription");
}

export async function architectStartSubscriptionAuth(input: {
  tenantId: string;
  providerId: string;
  computerBaseDir: string;
  architectToken?: string;
  hold: SubscriptionAuthHold;
}): Promise<SubscriptionAuthStarted> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const provider = findProvider(input.providerId);
  if (!provider || provider.mode !== "subscription") {
    throw new AvError(
      "SUBSCRIPTION_PROVIDER_REQUIRED",
      "Guided subscription auth is only for Codex Subscription, Grok Subscription, and GLM subscription",
    );
  }
  const modelId = modelIdForBind(provider, "");
  const started = await startSubscriptionLogin(provider.id);
  const session: SubscriptionAuthSession = {
    authId: newId("subauth"),
    tenantId: input.tenantId,
    providerId: provider.id,
    modelId,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    poll: started.poll,
  };
  input.hold.put(session);
  return {
    authId: session.authId,
    providerId: session.providerId,
    modelId: session.modelId,
    ...(session.userCode ? { userCode: session.userCode } : {}),
    verificationUri: session.verificationUri,
    status: "pending",
  };
}

export async function architectCompleteSubscriptionAuth(input: {
  tenantId: string;
  authId: string;
  computerBaseDir: string;
  architectToken?: string;
  hold: SubscriptionAuthHold;
  callbackUrl?: string;
}): Promise<SubscriptionAuthPending | SubscriptionAuthBound> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const authId = input.authId.trim();
  if (!authId) {
    throw new AvError("SUBSCRIPTION_AUTH_REQUIRED", "Guided subscription auth must be started first");
  }
  const session = input.hold.get(authId);
  if (!session || session.tenantId !== input.tenantId) {
    throw new AvError("SUBSCRIPTION_AUTH_REQUIRED", "Guided subscription auth must be started first");
  }
  let polled: Awaited<ReturnType<typeof pollSubscriptionLogin>>;
  try {
    polled = await pollSubscriptionLogin(session.poll, { callbackUrl: input.callbackUrl });
  } catch (err) {
    input.hold.drop(authId);
    throw err;
  }
  if (polled.status === "authorization_pending") {
    return { authId, status: "authorization_pending" };
  }
  const bound = architectBindAdapter({
    tenantId: input.tenantId,
    modelId: session.modelId,
    computerBaseDir: input.computerBaseDir,
    architectToken: input.architectToken,
  });
  architectWriteAdapterCredentials({
    tenantId: input.tenantId,
    apiKey: polled.accessToken,
    computerBaseDir: input.computerBaseDir,
    architectToken: input.architectToken,
  });
  input.hold.drop(authId);
  return {
    ok: true,
    authId,
    modelId: bound.modelId,
    boundBy: "architect",
    status: "bound",
  };
}
