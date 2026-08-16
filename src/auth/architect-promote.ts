import { AvError, SurfaceViolationError } from "../errors.js";
import type { EvalResult } from "../eval/runner.js";
import { writeSkillFile } from "../habitat/skills.js";
import { assertProposalNotPolicy, readProposalFile } from "../habitat/proposals.js";
import type { SkillFile } from "../habitat/types.js";
import type { LoadedPack } from "../packs/types.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect + eval promotion of a habitat proposal (HK-071 / DEC-013).
 * Copies a complete skill_draft into the live skill store after eval.
 * A proposal is not a skill until this path. Field cannot promote.
 * Habitat cannot promote itself. Unsigned or incomplete proposals fail closed.
 */
export function architectPromoteProposal(input: {
  tenantId: string;
  name: string;
  computerBaseDir: string;
  pack: LoadedPack;
  eval: { run(pack: LoadedPack): EvalResult };
  architectToken?: string;
}): SkillFile {
  const name = input.name.trim();
  if (!name) {
    throw new AvError("PROPOSAL_NAME_INVALID", "Architect promote requires a proposal name");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const proposal = readProposalFile(input.computerBaseDir, input.tenantId, name);
  assertProposalNotPolicy(proposal);
  if (proposal.kind !== "skill_draft") {
    throw new AvError(
      "PROPOSAL_NOT_SKILL",
      "A strategy note is not a skill; refusing to promote it into the live skill store",
    );
  }
  const result = input.eval.run(input.pack);
  if (!result.passed) {
    throw new AvError(
      "PROPOSAL_EVAL_FAILED",
      `Promotion requires Architect + eval; eval failed: ${result.failed.join(", ") || "eval did not pass"}`,
    );
  }
  return writeSkillFile(input.computerBaseDir, input.tenantId, {
    name: proposal.name,
    description: proposal.description,
    body: proposal.body,
  });
}

/**
 * Field promote is refused. Habitat cannot call this — use requireArchitect.
 * A field token is SURFACE_VIOLATION. A proposal stays a proposal.
 */
export function fieldPromoteProposal(): never {
  throw new SurfaceViolationError("Field cannot promote a proposal; promotion is Architect + eval only");
}
