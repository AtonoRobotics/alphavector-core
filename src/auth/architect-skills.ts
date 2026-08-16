import { AvError } from "../errors.js";
import { writeSkillFile } from "../habitat/skills.js";
import type { SkillFile } from "../habitat/types.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/skills/{name}/SKILL.md (HK-070 / DEC-020).
 * Same class as adapter-bind / routines / field-tokens. Shell is not Architect.
 * Field SHALL NOT add, author, or upload. Not a /field route.
 *
 * This is the write/promote path. Eval-gated promotion is HK-071 — do not
 * invent a promotion exam here.
 */
export function architectWriteSkill(input: {
  tenantId: string;
  name: string;
  description: string;
  body: string;
  computerBaseDir: string;
  architectToken?: string;
}): SkillFile {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.trim();
  if (!name) {
    throw new AvError("SKILL_NAME_INVALID", "Architect skill write requires a name");
  }
  if (!description) {
    throw new AvError("SKILL_DESCRIPTION_REQUIRED", "Architect skill write requires a description");
  }
  if (!body) {
    throw new AvError("SKILL_BODY_REQUIRED", "Architect skill write requires a body the worker can load");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  return writeSkillFile(input.computerBaseDir, input.tenantId, { name, description, body });
}
