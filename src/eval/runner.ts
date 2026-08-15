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
}
