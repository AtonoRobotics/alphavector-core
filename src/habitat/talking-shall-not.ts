import type { CognitiveIntent } from "./types.js";

/**
 * HK-031 talking / orchestrator SHALL NOT list, as typed fail-closed rejects.
 * Heavy work stays TALKING_PASS on the existing propose_effect check.
 * HABITAT_CANNOT_PROMOTE stays the proposal→skill door, not these rejects.
 * Not a trust ladder. Named rejects only — not a general illegal-verb ledger.
 */
export const TALKING_SHALL_NOT = [
  {
    code: "TALKING_GRANT_TRUST",
    message: "Talking pass must not grant trust",
    act: "grant_trust",
    field: "grantTrust",
  },
  {
    code: "TALKING_PROMOTE_POLICY",
    message: "Talking pass must not promote policy",
    act: "promote_policy",
    field: "promotePolicy",
  },
  {
    code: "TALKING_ALTER_EVALUATORS",
    message: "Talking pass must not alter evaluators",
    act: "alter_evaluators",
    field: "alterEvaluators",
  },
  {
    code: "TALKING_REWRITE_SUCCESS_CRITERIA",
    message: "Talking pass must not rewrite success criteria",
    act: "rewrite_success_criteria",
    field: "rewriteSuccessCriteria",
  },
  {
    code: "TALKING_SKIP_CARD",
    message: "Talking pass must not skip a card",
    act: "skip_card",
    field: "skipCard",
  },
  {
    code: "TALKING_EXECUTE_EFFECT",
    message: "Talking pass must not execute an external effect",
    act: "execute_effect",
    field: "executeEffect",
  },
  {
    code: "TALKING_WORLD_CALL",
    message: "Talking pass must not call the world except through a kernel verb",
    act: "world_call",
    field: "worldCall",
  },
] as const;

export type TalkingShallNotCode = (typeof TALKING_SHALL_NOT)[number]["code"];
export type TalkingShallNotAct = (typeof TALKING_SHALL_NOT)[number]["act"];
export type TalkingShallNotField = (typeof TALKING_SHALL_NOT)[number]["field"];

export function isTalkingShallNotAct(act: unknown): act is TalkingShallNotAct {
  return TALKING_SHALL_NOT.some((rule) => rule.act === act);
}

export function talkingShallNotReject(
  intent: CognitiveIntent,
): { code: TalkingShallNotCode; message: string } | undefined {
  const raw = intent as CognitiveIntent & Record<string, unknown>;
  const act = String(raw.act);
  for (const rule of TALKING_SHALL_NOT) {
    if (act === rule.act || raw[rule.field] !== undefined) {
      return { code: rule.code, message: rule.message };
    }
  }
  return undefined;
}

/** Copy named SHALL NOT markers so a hosted think body reaches the kernel reject. */
export function copyTalkingShallNotMarkers(
  raw: Record<string, unknown>,
  intent: CognitiveIntent,
): void {
  const next = intent as CognitiveIntent & Record<string, unknown>;
  for (const rule of TALKING_SHALL_NOT) {
    if (raw[rule.field] !== undefined) {
      next[rule.field] = raw[rule.field];
    }
  }
}
