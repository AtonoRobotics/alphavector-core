import type { AgentRecord } from "../agents/types.js";
import type { LoadedPack } from "../packs/types.js";
import type { StemDecision } from "./stem.js";

/**
 * Closed v1 wake kinds (HK-011). Existing names stay: field_continue,
 * card_decide, connector. This slice adds architect_message and worker_failed.
 * Adding a kind outside this set is a spec change.
 */
export const WAKE_KINDS = [
  "field_start",
  "field_ask",
  "field_continue",
  "card_decide",
  "worker_done",
  "worker_failed",
  "kill",
  "deadline",
  "connector",
  "routine",
  "mail",
  "architect_message",
] as const;

export type WakeKind = (typeof WAKE_KINDS)[number];

export type RunStatus =
  | "open"
  | "talking"
  | "working"
  | "awaiting_card"
  | "completed"
  | "denied"
  | "killed";

export type WorkerTypeId = "coder";

/** Habitat owns the coder type. Not the Deep Agents SDK. */
export const CODER_TYPE = {
  id: "coder" as const,
  executor: true,
  branch: true,
};

export const HABITAT_OWNED = ["wake", "run", "worker", "admit", "coder"] as const;
export const ADAPTER_OWNED = ["think"] as const;

export interface WakeEvent {
  kind: WakeKind;
  tenantId: string;
  pack?: LoadedPack;
  goal?: string;
  journeyId?: string;
  recordId?: string;
  runId?: string;
  cardId?: string;
  decision?: "approved" | "denied";
  reason?: string;
  workerId?: string;
  /** Stored routine id. Required for kind "routine"; pack declaration is not enough. */
  routineId?: string;
  /**
   * Existing pack agent who receives mail, or the addressed role-agent on
   * architect_message. Absent architect_message loads the orchestrator.
   */
  addresseeId?: string;
  /** Stored mail id. Required for kind "mail"; in-process AgentMail is not enough. */
  mailId?: string;
  /** Sender agent id, or "architect". Field cannot forge this. */
  fromAgentId?: string;
  /** Stored deadline id. Required for kind "deadline"; refusing to invent. */
  deadlineId?: string;
  /** Architect-bound connector id. Required for kind "connector"; ConnectorBook is not enough. */
  connectorId?: string;
  /**
   * Rejected on field_continue / worker_done. Field SHALL NOT pick who works.
   * Not a live assignee. Kernel ignores this for dispatch.
   */
  agentId?: string;
  /**
   * Rejected on field_continue / worker_done. Field SHALL NOT pick a worker type.
   * Habitat owns the coder type.
   */
  workerType?: string;
  /** Rejected on field_continue / worker_done. Field SHALL NOT pick an assignee. */
  assigneeAgentId?: string;
  /**
   * Rejected. Field SHALL NOT set the run orchestrator. Kernel sets it
   * from the loaded orchestrator. Not a field picker.
   */
  orchestratorId?: string;
  /**
   * Rejected. Field SHALL NOT set the run budget. Kernel-owned.
   * Not a trust-ladder number.
   */
  budget?: number;
  /**
   * Rejected. Field SHALL NOT set run.nextWake. Kernel writes it from a
   * validated adapter decision. Stem fires it on the habitat clock.
   */
  nextWake?: string;
}

export interface PendingEffect {
  actionClass: string;
  channel: string;
  purpose: string;
  subject: string;
  agentId: string;
  /** Email/SMS send. Required at world invoke for those channels. */
  to?: string;
  body?: string;
  from?: string;
}

/** Kernel-owned empty run budget. Not a trust-ladder number. Field SHALL NOT set this. */
export const KERNEL_RUN_BUDGET = 0;

export interface RunRecord {
  runId: string;
  tenantId: string;
  /** Objective. Existing name stays — do not rename to objective. */
  goal: string;
  status: RunStatus;
  /** Loaded orchestrator for this run. Kernel sets this. Field SHALL NOT. */
  orchestratorId: string;
  /** Booked worker ids on this run. Empty or one today. Not a new worker type. */
  workers: string[];
  /**
   * Next wake due time (ISO). Empty means nothing to fire.
   * Kernel writes this from a validated adapter decision. Field SHALL NOT.
   * The habitat clock fires it through stem as field_continue on this run.
   */
  nextWake: string;
  /** Kernel-owned budget. Empty/zero. Not a trust ladder. Field SHALL NOT set this. */
  budget: number;
  workerId?: string;
  workerType?: WorkerTypeId;
  pendingCardId?: string;
  pendingEffect?: PendingEffect;
  pendingIntent?: "launch_worker";
  journeyId?: string;
  recordId?: string;
  talkingDidHeavyWork: false;
  createdAt: string;
  updatedAt: string;
}

/**
 * Immutable eval-spine record (HK-014). Every persisted wake has kind, time,
 * tenant, run, target, and payloadHash. seq is append-only order.
 * tenantId / runId / at stay as aliases of tenant / run / time.
 */
export interface WakeLogEntry {
  seq: number;
  kind: WakeKind;
  /** ISO timestamp. Required name for the eval spine. */
  time: string;
  /** Tenant id. Required name for the eval spine. */
  tenant: string;
  /** Open or just-created run id. Required — do not persist a wake without a run. */
  run: string;
  /**
   * Who the wake is aimed at: orchestrator | ops | addressed agent id | worker
   * (or the concrete worker id). Derived from stem / admission. Not a WakeKind.
   */
  target: string;
  /** Hash of the wake payload, not the stem decision. */
  payloadHash: string;
  tenantId: string;
  runId: string;
  at: string;
  /** Stem decision persisted at append. Missing on replay is fail-closed. */
  decision: StemDecision;
  detail?: Record<string, unknown>;
}

export interface AgentProfile {
  agentId: string;
  tenantId: string;
  notes: string[];
  updatedAt: string;
}

export interface DatedLogEntry {
  logId: string;
  agentId: string;
  tenantId: string;
  date: string;
  text: string;
  createdAt: string;
  isFact: false;
}

export interface RecallItem {
  recallId: string;
  scope: "agent" | "user" | "tenant";
  subjectId: string;
  text: string;
  createdAt: string;
  isFact: false;
}

/** Labeled memory injected on every wake. An unlabeled blob does not count. */
export interface LabeledMemory {
  profile: { label: "profile"; agentId: string; body: AgentProfile | null };
  logs: { label: "logs"; agentId: string; entries: DatedLogEntry[] };
  recall: { label: "recall"; scope: string; items: RecallItem[] };
}

/** Loaded agentskills file. Path alone is not a skill — body was read. */
export interface SkillFile {
  name: string;
  description: string;
  body: string;
  path: string;
}

/** Habitat-written proposal kinds. A strategy note is not a skill draft. */
export type ProposalKind = "skill_draft" | "strategy";

/**
 * Habitat-written proposal on tenant disk (HK-071).
 * Not a skill. Not loaded on the next wake. Not policy.
 */
export interface ProposalFile {
  name: string;
  kind: ProposalKind;
  description: string;
  body: string;
  path: string;
  isSkill: false;
  isPolicy: false;
}

export type AdapterPass = "talking" | "worker";

/** Live bind resolved by the kernel from Architect-written adapter-bind.json. */
export interface AdapterBind {
  modelId: string;
  /** Hosted-model base URL from the Architect bind. Not process env. Not a field setter. */
  vendorBaseUrl?: string;
}

/**
 * Provider credentials resolved by the kernel from Architect-written
 * adapter-credentials.json. Never persist on bind, pack, trailer, or wake-log.
 */
export interface AdapterCredentials {
  apiKey: string;
}

export interface AdapterInput {
  pass: AdapterPass;
  event: WakeEvent;
  run: RunRecord;
  memory: LabeledMemory;
  skills: SkillFile[];
  /** Present only after Architect bind. Never a field or createDeepAgent option. */
  bind?: AdapterBind;
  /**
   * Present only after Architect writes provider credentials.
   * Think uses this to authorize the vendor hop. Never log. Never copy to trailer.
   */
  credentials?: AdapterCredentials;
}

export interface CognitiveIntent {
  pass: AdapterPass;
  act: "launch_worker" | "propose_effect" | "done" | "follow_up";
  workerType?: WorkerTypeId;
  actionClass?: string;
  channel?: string;
  purpose?: string;
  subject?: string;
  /** Email/SMS send. Required at world invoke for those channels. */
  to?: string;
  body?: string;
  from?: string;
  /**
   * Optional ISO due time. Kernel persists this onto run.nextWake after
   * validation. Absent means the adapter did not decide. Empty clears.
   * Invalid or unvalidated is fail-closed — do not persist.
   */
  nextWake?: string;
}

export interface CognitiveAdapter {
  readonly name: string;
  readonly owns: readonly string[];
  /** DeepAgentsAdapter requires an Architect bind. Dry-stem (eval) does not. */
  readonly requiresBind?: boolean;
  /**
   * Product DeepAgentsAdapter requires Architect-written provider credentials.
   * An explicit CI thinkFn double does not.
   */
  readonly requiresCredentials?: boolean;
  think(input: AdapterInput): CognitiveIntent | Promise<CognitiveIntent>;
}

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  runId: string;
  type: WorkerTypeId;
  isolation: "trailer";
  trailerPath: string;
  branch: string;
  pid?: number;
  agent: AgentRecord;
  createdAt: string;
}

/**
 * Trailer isolation as a record. Habitat isolation is trailer, not a boolean flag.
 * Directory presence is not liveness — `live` is the booked pid.
 */
export interface HabitatIsolationRecord {
  isolation: "trailer";
  workerId?: string;
  trailerPath?: string;
  exists: boolean;
  live: boolean;
}

export interface WakeResult {
  run?: RunRecord;
  wokeOrchestrator: boolean;
  wokeOps: boolean;
  launchedWorker: boolean;
  talkingDidHeavyWork: false;
  effect?: { actionId: string; executed: boolean; policyDecision: string };
  cardId?: string;
  memory: LabeledMemory;
}
