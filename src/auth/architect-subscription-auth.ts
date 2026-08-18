import { AvError } from "../errors.js";
import { newId } from "../ids.js";
import {
  pollSubscriptionLogin,
  startSubscriptionLogin,
  type OfficialLoginPollHandle,
} from "../habitat/subscription-auth.js";
import {
  GLM_HOLD_TTL_MS,
  glmHoldNowMs,
  receiveGlmAuthorizationCode,
} from "../habitat/vendor-login.js";
import { findProvider, modelIdForBind } from "../http/architect-habitat-wizard.js";
import { architectBindAdapter } from "./architect-adapter-bind.js";
import { architectWriteAdapterCredentials } from "./architect-adapter-credentials.js";
import { requireArchitect } from "./require-architect.js";

/**
 * In-flight official login held by the habitat wizard. Not a second secrets plane.
 * After complete, session tokens are written through architectWriteAdapterCredentials.
 * HTTP never returns them. Does not copy a host CLI session file.
 */
export interface SubscriptionAuthSession {
  authId: string;
  tenantId: string;
  providerId: string;
  modelId: string;
  userCode?: string;
  verificationUri: string;
  poll: OfficialLoginPollHandle;
  /** GLM Continue with Z.ai hold. Missing on Codex/Grok device-code. */
  heldUntilMs?: number;
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
    const session = this.sessions.get(authId);
    if (!session) return undefined;
    if (session.heldUntilMs !== undefined && glmHoldNowMs() > session.heldUntilMs) {
      this.sessions.delete(authId);
      return undefined;
    }
    return session;
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
  allowHeldSeat?: boolean;
  hold: SubscriptionAuthHold;
}): Promise<SubscriptionAuthStarted> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    allowHeldSeat: input.allowHeldSeat,
  });
  const provider = findProvider(input.providerId);
  if (!provider || provider.mode !== "subscription" || provider.fields.subscriptionAuth !== "guided") {
    throw new AvError(
      "SUBSCRIPTION_PROVIDER_REQUIRED",
      "Guided subscription auth is Codex Subscription, Grok Subscription, or GLM Subscription",
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
    ...(started.poll.kind === "glm-auth-code"
      ? { heldUntilMs: glmHoldNowMs() + GLM_HOLD_TTL_MS }
      : {}),
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
  allowHeldSeat?: boolean;
  hold: SubscriptionAuthHold;
  code?: string;
  authCode?: string;
  state?: string;
}): Promise<SubscriptionAuthPending | SubscriptionAuthBound> {
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken, {
    allowHeldSeat: input.allowHeldSeat,
  });
  const authId = input.authId.trim();
  if (!authId) {
    throw new AvError("SUBSCRIPTION_AUTH_REQUIRED", "Guided subscription auth must be started first");
  }
  const session = input.hold.get(authId);
  if (!session || session.tenantId !== input.tenantId) {
    throw new AvError("SUBSCRIPTION_AUTH_REQUIRED", "Guided subscription auth must be started first");
  }
  const intercepted = (input.code ?? input.authCode ?? "").trim();
  const interceptedState = (input.state ?? "").trim();
  if (intercepted && interceptedState) {
    if (session.poll.kind === "glm-auth-code" && interceptedState !== session.poll.state) {
      throw new AvError("SUBSCRIPTION_AUTH_REJECTED", "ZCode official login state did not match");
    }
    receiveGlmAuthorizationCode(interceptedState, intercepted);
  }
  let polled: Awaited<ReturnType<typeof pollSubscriptionLogin>>;
  try {
    polled = await pollSubscriptionLogin(session.poll);
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
    allowHeldSeat: input.allowHeldSeat,
  });
  architectWriteAdapterCredentials({
    tenantId: input.tenantId,
    apiKey: polled.accessToken,
    refreshToken: polled.refreshToken,
    computerBaseDir: input.computerBaseDir,
    architectToken: input.architectToken,
    allowHeldSeat: input.allowHeldSeat,
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
