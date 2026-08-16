import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computerRoot } from "../computer/paths.js";
import type { LoadedPack } from "../packs/types.js";
import type { SkillFile } from "./types.js";

/**
 * Skill files are real files the worker or role-agent can read, not only string labels.
 */
export function writeSkillFiles(
  computerBaseDir: string | undefined,
  pack: LoadedPack,
): SkillFile[] {
  if (!computerBaseDir) return [];
  const dir = computerRoot(computerBaseDir, pack.tenantId).skillsDir;
  mkdirSync(dir, { recursive: true });
  const written = new Map<string, SkillFile>();
  for (const role of pack.binding.roles) {
    for (const name of role.skills) {
      if (written.has(name)) continue;
      const file = path.join(dir, `${safeName(name)}.md`);
      writeFileSync(file, `# ${name}\n\nPack skill file. Readable by the worker or role-agent.\n`, "utf8");
      written.set(name, { name, path: file });
    }
  }
  return [...written.values()];
}

export function copySkillsToTrailer(skills: SkillFile[], trailerPath: string): SkillFile[] {
  const dest = path.join(trailerPath, "skills");
  mkdirSync(dest, { recursive: true });
  return skills.map((skill) => {
    const file = path.join(dest, path.basename(skill.path));
    writeFileSync(file, `# ${skill.name}\n\nCopied into the worker trailer.\n`, "utf8");
    return { name: skill.name, path: file };
  });
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
