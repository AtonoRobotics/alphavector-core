import { FailClosedError } from "../errors.js";
import type { OutcomeEvidence } from "./types.js";

/**
 * DEC-017 numeric T0–T3 thresholds are not accepted.
 * Autonomy graduates only on independent outcome evidence.
 * DEC-023: surprise graduation is a product failure.
 * Graduation does not strip policy (DEC-012 / DEC-022).
 */
export function assertIndependentEvidence(evidence: OutcomeEvidence, actorAgentId: string): void {
  if (evidence.actorAgentId !== actorAgentId) {
    throw new FailClosedError("EVIDENCE_ACTOR_MISMATCH", "Evidence is not about this actor.");
  }
  if (evidence.evaluatorId === evidence.actorAgentId) {
    throw new FailClosedError(
      "SURPRISE_GRADUATION",
      "Surprise graduation is a product failure. Evaluator must be independent of the actor.",
    );
  }
  if (!evidence.summary.trim()) {
    throw new FailClosedError("SURPRISE_GRADUATION", "Graduation without outcome evidence is a product failure.");
  }
}

export function rejectNumericThresholds(input: unknown): void {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (/^t[0-3]$/i.test(key)) {
        throw new FailClosedError(
          "THRESHOLD_REJECTED",
          "DEC-017 numeric T0–T3 thresholds are not accepted.",
        );
      }
    }
  }
}
