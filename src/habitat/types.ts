import type { AgentRecord } from "../agents/types.js";
import type { LoadedPack } from "../packs/types.js";
import type { StemDecision } from "./stem.js";

/** Wake kinds. Connector, deadline, routine, and mail are live wakes. */
export type WakeKind =
  | "field_start"
  | "field_ask"
  | "card_decide"
  | "worker_done"
  | "kill"
  | "deadline"
  | "connector"
  | "routine"
  | "mail";

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
  /** Existing pack agent who receives the mail. Required for kind "mail". */
  addresseeId?: string;
  /** Stored mail id. Required for kind "mail"; in-process AgentMail is not enough. */
  mailId?: string;
  /** Sender agent id, or "architect". Field cannot forge this. */
  fromAgentId?: string;
  /** Stored deadline id. Required for kind "deadline"; refusing to invent. */
  deadlineId?: string;
  /** Architect-bound connector id. Required for kind "connector"; ConnectorBook is not enough. */
  connectorId?: string;
}

export interface PendingEffect {
  actionClass: string;
  channel: string;
  purpose: string;
  subject: string;
  agentId: string;
}

export interface RunRecord {
  runId: string;
  tenantId: string;
  goal: string;
  status: RunStatus;
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

export interface WakeLogEntry {
  seq: number;
  kind: WakeKind;
  tenantId: string;
  runId?: string;
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

export interface SkillFile {
  name: string;
  path: string;
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
