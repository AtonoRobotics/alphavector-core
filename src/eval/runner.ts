import type { WakeLogEntry } from "../habitat/types.js";
import { replayWakeLog } from "../habitat/wake-log.js";
import type { LoadedPack } from "../packs/types.js";

export interface EvalResult {
  passed: boolean;
  failed: string[];
}

export class EvalRunner {
  run(pack: LoadedPack): EvalResult {
    const failed: string[] = [];
    if (pack.binding.evidenceEvalFixtures.length === 0) {
      failed.push("no evidence/eval fixtures");
    }
    if (!pack.binding.evidenceEvalFixtures.some((f) => f.countsAsIndependentOutcome)) {
      failed.push("no independent outcome evidence kind");
    }
    return { passed: failed.length === 0, failed };
  }

  /** Replay habitat facilities from a wake log. No model. */
  replayFacilities(entries: WakeLogEntry[]): ReturnType<typeof replayWakeLog> {
    return replayWakeLog(entries);
  }
}
