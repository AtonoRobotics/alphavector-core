import { createDeepAgent } from "deepagents";
import { dryThink } from "./adapter.js";
import type { AdapterInput, CognitiveAdapter, CognitiveIntent } from "./types.js";

export { createDeepAgent };

/**
 * Deep Agents SDK is the cognitive adapter only (DEC-003).
 * A library version SHALL NOT be a core fork. The SDK does not own
 * wake, run, worker, admit, or the coder type. This slice does not
 * invoke the library loop (no model; field cannot configure one).
 */
export class DeepAgentsAdapter implements CognitiveAdapter {
  readonly name = "deepagents";
  readonly owns = ["think"] as const;
  static readonly sdkEntry = createDeepAgent;
  static invocations = 0;

  think(input: AdapterInput): CognitiveIntent {
    // Adapter boundary only. Do not call createDeepAgent() — that would
    // let the library own the loop. Kernel still wake / run / worker / admit.
    return dryThink(input);
  }
}

export function resetDeepAgentsInvocations(): void {
  DeepAgentsAdapter.invocations = 0;
}
