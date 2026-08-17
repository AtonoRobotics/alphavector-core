import { AvError } from "../errors.js";
import type { CognitiveIntent } from "./types.js";

export const DECISION_ASSUMPTIONS = "DECISION_ASSUMPTIONS";
export const DECISION_RISKS = "DECISION_RISKS";
export const DECISION_NEXT_WAKE_OR_STOP = "DECISION_NEXT_WAKE_OR_STOP";

/** Fixture-only completeness. Kernel validate and the vendor mapper do not call this. */
export type FixtureDecisionInput = Omit<CognitiveIntent, "assumptions" | "risks" | "act"> & {
  act: CognitiveIntent["act"] | (string & {});
  assumptions?: string[];
  risks?: string[];
};

/**
 * Fixture helper for DryStem / adapterThink / CI doubles.
 * Product think and kernel validate do not fill omitted fields.
 */
export function fixtureTypedDecision(
  intent: FixtureDecisionInput,
  from?: { nextWake?: string },
): CognitiveIntent {
  return {
    assumptions: [],
    risks: [],
    ...(intent.act === "done" ? {} : { nextWake: from?.nextWake ?? "" }),
    ...intent,
    act: intent.act as CognitiveIntent["act"],
  };
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** act === done is stop. Any other act must carry nextWake (empty is a clear). */
export function hasNextWakeOrStop(intent: { act: string; nextWake?: unknown }): boolean {
  return intent.act === "done" || intent.nextWake !== undefined;
}

export function decisionAssumptionsError(): AvError {
  return new AvError(
    DECISION_ASSUMPTIONS,
    "Typed decision must include assumptions; omitting is fail-closed",
  );
}

export function decisionRisksError(): AvError {
  return new AvError(DECISION_RISKS, "Typed decision must include risks; omitting is fail-closed");
}

export function decisionNextWakeOrStopError(): AvError {
  return new AvError(
    DECISION_NEXT_WAKE_OR_STOP,
    "Typed decision must set nextWake or act done; omitting both is fail-closed",
  );
}
