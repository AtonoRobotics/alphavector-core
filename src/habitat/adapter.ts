import type { AdapterInput, CognitiveAdapter, CognitiveIntent } from "./types.js";

/**
 * Fixture / dry stem. No model. Eval and tests replay facilities with this.
 */
export class DryStemAdapter implements CognitiveAdapter {
  readonly name = "dry-stem";
  readonly owns = ["think"] as const;

  think(input: AdapterInput): CognitiveIntent {
    return dryThink(input);
  }
}

export function dryThink(input: AdapterInput): CognitiveIntent {
  if (input.pass === "talking") {
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
