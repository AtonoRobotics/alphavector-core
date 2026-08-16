import type { FieldCardView } from "../auth/types.js";
import type { Journey } from "../data/types.js";
import type {
  FieldFactResult,
  FieldHome,
  FieldProgressResult,
  FieldRecordResult,
} from "../surfaces/types.js";

export interface FieldProgressBody {
  note?: string;
  actionClass?: string;
  channel?: string;
  purpose?: string;
  subject?: string;
  ask?: { text: string; actionClass: string };
  /** Claims only. Does not write the tenant fact store. */
  conditions?: string[];
}

export interface FieldAskBody {
  text: string;
  actionClass: string;
}

export interface FieldStartBody {
  journeyKind: string;
  objective: string;
  /** Claims only. Does not write the tenant fact store. */
  conditions?: string[];
}

/** Generic fact id. Pack-local string; not an RE type. */
export interface FieldFactBody {
  id: string;
  /** Subject record id. Absent = tenant-global. */
  recordId?: string;
}

/** Generic record create. type is a pack string or a field-supplied label. */
export interface FieldRecordBody {
  type: string;
  label: string;
}

export interface FieldApproveResult {
  card: { cardId: string; status: string };
  journey?: Journey;
  effect?: FieldProgressResult["effect"];
  fact?: FieldFactResult;
  record?: FieldRecordResult;
}

export interface FieldHttpErrorBody {
  error: string;
  message: string;
  cardId?: string;
}

export type FieldHomeResponse = FieldHome;
export type FieldCardListResponse = { cards: FieldCardView[] };
