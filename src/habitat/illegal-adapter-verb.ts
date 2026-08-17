import { AvError } from "../errors.js";

/**
 * HK-032 illegal adapter tool or verb. Fail-closed with run + wake evidence
 * on the talkingReject spine. Named HK-031 SHALL NOT codes win first.
 * Not a new WakeKind. Not a trust ladder.
 *
 * ADAPTER_VENDOR_REJECTED without that evidence is not enough — the kernel
 * records { code, closed: true } on the run and wake before the throw.
 */
export const ILLEGAL_ADAPTER_VERB = "ADAPTER_VENDOR_REJECTED" as const;

export type IllegalAdapterVerbCode = typeof ILLEGAL_ADAPTER_VERB;

/** Talking kernel verbs. propose_effect is heavy work (TALKING_PASS), not this list. */
export const LEGAL_TALKING_VERBS = [
  "launch_worker",
  "done",
  "follow_up",
  "write_brief",
  "steer",
  "report",
] as const;

export type LegalTalkingVerb = (typeof LEGAL_TALKING_VERBS)[number];

/** Worker must propose the one external effect. Any other tool/verb is illegal. */
export const LEGAL_WORKER_VERBS = ["propose_effect"] as const;

export type LegalWorkerVerb = (typeof LEGAL_WORKER_VERBS)[number];

export function isLegalTalkingVerb(act: unknown): act is LegalTalkingVerb {
  return LEGAL_TALKING_VERBS.some((verb) => verb === act);
}

export function isLegalWorkerVerb(act: unknown): act is LegalWorkerVerb {
  return LEGAL_WORKER_VERBS.some((verb) => verb === act);
}

export function isIllegalAdapterVerbError(err: unknown): err is AvError {
  return err instanceof AvError && err.code === ILLEGAL_ADAPTER_VERB;
}
