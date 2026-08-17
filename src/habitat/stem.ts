import type { WakeEvent } from "./types.js";

export interface StemDecision {
  wakeOrchestrator: boolean;
  wakeOps: boolean;
}

/**
 * Deterministic stem. No model. Eval can replay this.
 */
export function stem(event: WakeEvent): StemDecision {
  switch (event.kind) {
    case "field_start":
    case "field_ask":
    case "field_continue": // habitat clock fires run.nextWake as this kind
    case "routine":
    case "mail":
    case "deadline":
    case "connector":
    case "architect_message":
    case "worker_failed":
      return { wakeOrchestrator: true, wakeOps: false };
    case "worker_done":
      return { wakeOrchestrator: true, wakeOps: true };
    case "card_decide":
      return { wakeOrchestrator: true, wakeOps: event.decision === "approved" };
    case "kill":
      return { wakeOrchestrator: false, wakeOps: false };
    default:
      return { wakeOrchestrator: false, wakeOps: false };
  }
}
