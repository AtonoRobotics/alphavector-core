import { createDeepAgent } from "deepagents";
import { AvError } from "../errors.js";
import type { AdapterInput, CognitiveAdapter, CognitiveIntent } from "./types.js";
import { recordedVendorClient, vendorThink, type VendorThinkClient } from "./vendor-think.js";

export { createDeepAgent };

export type AdapterThinkFn = (input: AdapterInput) => CognitiveIntent;
export type DeepAgentsThinkPath = "vendor" | "double";

export interface DeepAgentsAdapterOptions {
  /** Explicit CI test double. Not the product default. */
  thinkFn?: AdapterThinkFn;
  /** Explicit recorded vendor fixture. Not adapterThink. */
  vendor?: VendorThinkClient;
}

/**
 * Deep Agents SDK is the cognitive adapter only (DEC-003).
 * A library version SHALL NOT be a core fork. The SDK does not own
 * wake, run, worker, admit, or the coder type.
 *
 * The published SDK entry is imported as sdkEntry. It SHALL NOT own the loop.
 * Think is this adapter. Kernel still wake / run / worker / admit / coder.
 *
 * Product think: Architect bind + Architect-written credentials → vendor hop
 * (recorded vendor fixture this slice; live hosted model is leftover).
 * An explicit thinkFn is the CI test-double path. It is not the product default.
 * Dry-stem is not this adapter's production path.
 */
export class DeepAgentsAdapter implements CognitiveAdapter {
  readonly name = "deepagents";
  readonly owns = ["think"] as const;
  readonly requiresBind = true;
  readonly requiresCredentials: boolean;
  static readonly sdkEntry = createDeepAgent;
  static invocations = 0;
  static vendorInvocations = 0;
  static lastModelId: string | undefined;
  static lastThinkPath: DeepAgentsThinkPath | undefined;
  private readonly thinkFn?: AdapterThinkFn;
  private readonly vendor: VendorThinkClient;

  constructor(thinkFnOrOpts?: AdapterThinkFn | DeepAgentsAdapterOptions) {
    const opts = normalizeOpts(thinkFnOrOpts);
    this.thinkFn = opts.thinkFn;
    this.vendor = opts.vendor ?? recordedVendorClient;
    this.requiresCredentials = !this.thinkFn;
  }

  think(input: AdapterInput): CognitiveIntent {
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
    return vendorThink(input, { apiKey }, this.vendor);
  }
}

/**
 * Explicit CI test double. Not the product default.
 * Not DryStemAdapter. Not the SDK loop. Intent shape stays kernel-owned.
 */
export function adapterThink(input: AdapterInput): CognitiveIntent {
  if (input.pass === "talking") {
    if (input.event.kind === "field_ask") {
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
  };
}

export function resetDeepAgentsInvocations(): void {
  DeepAgentsAdapter.invocations = 0;
  DeepAgentsAdapter.vendorInvocations = 0;
  DeepAgentsAdapter.lastModelId = undefined;
  DeepAgentsAdapter.lastThinkPath = undefined;
}

function normalizeOpts(
  thinkFnOrOpts?: AdapterThinkFn | DeepAgentsAdapterOptions,
): DeepAgentsAdapterOptions {
  if (typeof thinkFnOrOpts === "function") return { thinkFn: thinkFnOrOpts };
  return thinkFnOrOpts ?? {};
}
