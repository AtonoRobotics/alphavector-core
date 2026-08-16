import { createDeepAgent } from "deepagents";
import { AvError } from "../errors.js";
import {
  intentFromSdkResult,
  sdkThinkPassFromInput,
  VendorBoundChatModel,
  type DeepAgentsSdkPass,
} from "./sdk-think.js";
import { RECORDED_EMAIL_SEND } from "./connector-world.js";
import type { AdapterInput, CognitiveAdapter, CognitiveIntent } from "./types.js";
import { hostedVendorClient, type VendorThinkClient } from "./vendor-think.js";

export { createDeepAgent };
export type { DeepAgentsSdkPass };

export type AdapterThinkFn = (input: AdapterInput) => CognitiveIntent;
export type DeepAgentsThinkPath = "vendor" | "double";

export interface DeepAgentsAdapterOptions {
  /** Explicit CI test double. Not the product default. */
  thinkFn?: AdapterThinkFn;
  /** Explicit hosted-model HTTP client. Tests inject a local base URL. */
  vendor?: VendorThinkClient;
  /**
   * Hosted-model base URL. CI/fixture override only.
   * Product reads the Architect bind. Not a field setter.
   */
  vendorBaseUrl?: string;
}

/**
 * Deep Agents SDK is the cognitive adapter only (DEC-003).
 * A library version SHALL NOT be a core fork. The SDK does not own
 * wake, run, worker, admit, persist, sleep, or the coder type.
 *
 * Product think constructs and invokes createDeepAgent inside this adapter.
 * Kernel still wake / run / worker / admit / coder / persist / sleep.
 * Skills (HK-070 bodies) and labeled memory (HK-072) are inputs to that pass.
 * Field cannot configure the model. Architect bind + credentials required.
 *
 * An explicit thinkFn is the CI test-double path. It is not the product default.
 */
export class DeepAgentsAdapter implements CognitiveAdapter {
  readonly name = "deepagents";
  readonly owns = ["think"] as const;
  readonly requiresBind = true;
  readonly requiresCredentials: boolean;
  static readonly sdkEntry = createDeepAgent;
  static invocations = 0;
  static vendorInvocations = 0;
  static sdkInvocations = 0;
  static lastModelId: string | undefined;
  static lastThinkPath: DeepAgentsThinkPath | undefined;
  static lastSdkPass: DeepAgentsSdkPass | undefined;
  private readonly thinkFn?: AdapterThinkFn;
  private readonly vendor: VendorThinkClient;

  constructor(thinkFnOrOpts?: AdapterThinkFn | DeepAgentsAdapterOptions) {
    const opts = normalizeOpts(thinkFnOrOpts);
    this.thinkFn = opts.thinkFn;
    this.vendor = opts.vendor ?? hostedVendorClient(opts.vendorBaseUrl);
    this.requiresCredentials = !this.thinkFn;
  }

  async think(input: AdapterInput): Promise<CognitiveIntent> {
    const modelId = input.bind?.modelId?.trim();
    if (!modelId) {
      throw new AvError(
        "ADAPTER_UNBOUND",
        "Architect must bind a model before think; no silent default",
      );
    }
    if (this.thinkFn) {
      DeepAgentsAdapter.invocations += 1;
      DeepAgentsAdapter.lastModelId = modelId;
      DeepAgentsAdapter.lastThinkPath = "double";
      return this.thinkFn(input);
    }
    const apiKey = input.credentials?.apiKey?.trim();
    if (!apiKey) {
      throw new AvError(
        "ADAPTER_CREDENTIALS_MISSING",
        "Architect must write provider credentials before think; no CI mapper default",
      );
    }
    DeepAgentsAdapter.invocations += 1;
    DeepAgentsAdapter.vendorInvocations += 1;
    DeepAgentsAdapter.lastModelId = modelId;
    DeepAgentsAdapter.lastThinkPath = "vendor";
    const pass = sdkThinkPassFromInput(input);
    DeepAgentsAdapter.lastSdkPass = pass;
    DeepAgentsAdapter.sdkInvocations += 1;
    const credentials = { apiKey };
    let result: unknown;
    try {
      const agent = createDeepAgent({
        model: new VendorBoundChatModel({ input, credentials, vendor: this.vendor }),
        name: "think",
        systemPrompt: pass.systemPrompt,
        ...(pass.skillSources.length ? { skills: pass.skillSources } : {}),
      });
      result = await agent.invoke({
        messages: [{ role: "user", content: pass.userContent }],
        files: pass.files,
      });
    } catch (err) {
      throwIfAvError(err);
      throw new AvError("ADAPTER_VENDOR_REJECTED", "Deep Agents SDK pass returned an unusable think body");
    }
    return intentFromSdkResult(result);
  }
}

/**
 * Explicit CI test double. Not the product default.
 * Not DryStemAdapter. Not the SDK loop. Intent shape stays kernel-owned.
 */
export function adapterThink(input: AdapterInput): CognitiveIntent {
  if (input.pass === "talking") {
    if (input.event.kind === "worker_done") {
      return { pass: "talking", act: "done" };
    }
    if (
      input.event.kind === "field_ask" ||
      input.event.kind === "field_continue" ||
      input.event.kind === "mail" ||
      input.event.kind === "deadline" ||
      input.event.kind === "architect_message" ||
      input.event.kind === "worker_failed"
    ) {
      return { pass: "talking", act: "follow_up" };
    }
    return { pass: "talking", act: "launch_worker", workerType: "coder" };
  }
  return {
    pass: "worker",
    act: "propose_effect",
    actionClass: "communicate",
    channel: "email",
    purpose: "follow-up",
    subject: input.run.recordId ?? input.event.recordId ?? "unspecified",
    ...RECORDED_EMAIL_SEND,
  };
}

export function resetDeepAgentsInvocations(): void {
  DeepAgentsAdapter.invocations = 0;
  DeepAgentsAdapter.vendorInvocations = 0;
  DeepAgentsAdapter.sdkInvocations = 0;
  DeepAgentsAdapter.lastModelId = undefined;
  DeepAgentsAdapter.lastThinkPath = undefined;
  DeepAgentsAdapter.lastSdkPass = undefined;
}

function normalizeOpts(
  thinkFnOrOpts?: AdapterThinkFn | DeepAgentsAdapterOptions,
): DeepAgentsAdapterOptions {
  if (typeof thinkFnOrOpts === "function") return { thinkFn: thinkFnOrOpts };
  return thinkFnOrOpts ?? {};
}

/** LangGraph wraps model errors; typed AvError must still fail closed. */
function throwIfAvError(err: unknown): void {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof AvError) throw current;
    if ("cause" in current) queue.push((current as { cause: unknown }).cause);
    if ("errors" in current && Array.isArray((current as { errors: unknown[] }).errors)) {
      queue.push(...(current as { errors: unknown[] }).errors);
    }
    if ("originalError" in current) queue.push((current as { originalError: unknown }).originalError);
  }
}
