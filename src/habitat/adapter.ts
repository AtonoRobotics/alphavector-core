import type { AdapterInput, CognitiveAdapter, CognitiveIntent } from "./types.js";

/**
 * Fixture / dry stem. No model. Eval and envelope tests pass this explicitly.
 * Not the field-serve / HabitatKernel product default.
 */
export class DryStemAdapter implements CognitiveAdapter {
  readonly name = "dry-stem";
  readonly owns = ["think"] as const;
  readonly requiresBind = false;

  think(input: AdapterInput): CognitiveIntent {
    return dryThink(input);
  }
}

export function dryThink(input: AdapterInput): CognitiveIntent {
  if (input.pass === "talking") {
    if (input.event.kind === "field_ask" || input.event.kind === "mail" || input.event.kind === "deadline") {
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
