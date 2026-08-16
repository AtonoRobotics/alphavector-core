import { createDeepAgent } from "deepagents";
import { AvError } from "../errors.js";
import type { AdapterInput, CognitiveAdapter, CognitiveIntent } from "./types.js";

export { createDeepAgent };

export type AdapterThinkFn = (input: AdapterInput) => CognitiveIntent;

/**
 * Deep Agents SDK is the cognitive adapter only (DEC-003).
 * A library version SHALL NOT be a core fork. The SDK does not own
 * wake, run, worker, admit, or the coder type.
 *
 * The published SDK entry is imported as sdkEntry. It SHALL NOT own the loop.
 * Think is this adapter. Kernel still wake / run / worker / admit / coder.
 *
 * Production think requires an Architect bind (HK-055). A test double is
 * the CI path. Dry-stem is not this adapter's production path.
 */
export class DeepAgentsAdapter implements CognitiveAdapter {
  readonly name = "deepagents";
  readonly owns = ["think"] as const;
  readonly requiresBind = true;
  static readonly sdkEntry = createDeepAgent;
  static invocations = 0;
  static lastModelId: string | undefined;
  private readonly thinkFn: AdapterThinkFn;

  constructor(thinkFn?: AdapterThinkFn) {
    this.thinkFn = thinkFn ?? adapterThink;
  }

  think(input: AdapterInput): CognitiveIntent {
    const modelId = input.bind?.modelId?.trim();
    if (!modelId) {
      throw new AvError(
        "ADAPTER_UNBOUND",
        "Architect must bind a model before think; no silent default",
      );
    }
    DeepAgentsAdapter.invocations += 1;
    DeepAgentsAdapter.lastModelId = modelId;
    return this.thinkFn(input);
  }
}

/**
 * Adapter think path. Not DryStemAdapter. Not the SDK loop.
 * A test double may replace this. Intent shape stays kernel-owned.
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
  DeepAgentsAdapter.lastModelId = undefined;
}
