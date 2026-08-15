import type { AgentRecord } from "../agents/types.js";
import type { PackDocument } from "../pack/types.js";

export interface EvalResult {
  passed: boolean;
  failures: string[];
}

/**
 * Pack eval fixtures are stance checks, not model calls.
 * Every agent must pass before acting. Core does not skip eval.
 */
export function runPackEval(pack: PackDocument, agent: AgentRecord): EvalResult {
  const failures: string[] = [];
  if (!agent.persona.trim()) {
    failures.push("persona is empty");
  }
  if (agent.skills.length === 0) {
    failures.push("skills are empty");
  }
  for (const fixture of pack.eval.fixtures) {
    if (!fixture.mustPass) {
      failures.push(`eval fixture ${fixture.id} is not marked mustPass`);
    }
    if (fixture.expectedStance === "refuse_unauthorized" && !agent.skills.length) {
      failures.push(`agent ${agent.name} cannot refuse unauthorized effects without skills`);
    }
  }
  if (pack.eval.fixtures.length === 0) {
    failures.push("pack eval fixtures are required");
  }
  return { passed: failures.length === 0, failures };
}
