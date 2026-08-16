import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import type { SkillFile } from "./types.js";

/**
 * Architect-written skill files on tenant disk (HK-070 / DEC-020).
 * A skill is an agentskills-shaped file (SKILL.md / frontmatter + body)
 * the worker or role-agent actually loads. A string on a role record,
 * a pack label, or a comment is not a skill.
 *
 * Same class as other tenant files beside disk/: never inside the
 * bind-mounted /home. Field SHALL NOT add, author, or upload.
 * Habitat self-improve writes a proposal (HK-071), not this store.
 * Eval-gated promotion copies a complete proposal here after Architect + eval.
 */

export function skillFilePath(computerBaseDir: string, tenantId: string, name: string): string {
  return path.join(computerRoot(computerBaseDir, tenantId).skillsDir, safeName(name), "SKILL.md");
}

export function writeSkillFile(
  computerBaseDir: string,
  tenantId: string,
  skill: { name: string; description: string; body: string },
): SkillFile {
  const name = assertSkillName(skill.name);
  const description = skill.description.trim();
  const body = skill.body.replace(/\r\n/g, "\n").trim();
  if (!description) {
    throw new AvError("SKILL_DESCRIPTION_REQUIRED", "Skill write requires a description");
  }
  if (!body) {
    throw new AvError("SKILL_BODY_REQUIRED", "Skill write requires a body the worker can load");
  }
  const file = skillFilePath(computerBaseDir, tenantId, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeSkillMarkdown({ name, description, body }), "utf8");
  return { name, description, body, path: file };
}

/**
 * Load every Architect-written skill on the tenant computer.
 * Missing store (no skills dir) is empty — Architect has not written yet.
 * A skill directory without SKILL.md is missing (typed). Unreadable or
 * unparseable SKILL.md is corrupt (typed). Does not invent files from
 * pack role string labels.
 */
export function loadSkillFiles(computerBaseDir: string | undefined, tenantId: string): SkillFile[] {
  if (!computerBaseDir) return [];
  const dir = computerRoot(computerBaseDir, tenantId).skillsDir;
  if (!existsSync(dir)) return [];
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    throw skillCorrupt();
  }
  if (!st.isDirectory()) throw skillCorrupt();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw skillCorrupt();
  }
  const loaded: SkillFile[] = [];
  for (const entry of names.sort()) {
    const child = path.join(dir, entry);
    let childSt: ReturnType<typeof statSync>;
    try {
      childSt = statSync(child);
    } catch {
      throw skillCorrupt();
    }
    if (!childSt.isDirectory()) continue;
    const file = path.join(child, "SKILL.md");
    if (!existsSync(file)) {
      throw new AvError(
        "SKILL_MISSING",
        `Skill file is missing; refusing to invent ${entry}`,
      );
    }
    loaded.push(readSkillPath(file));
  }
  return loaded;
}

/** Read one named skill. Missing or corrupt fails closed. */
export function readSkillFile(
  computerBaseDir: string | undefined,
  tenantId: string,
  name: string,
): SkillFile {
  const wanted = assertSkillName(name);
  if (!computerBaseDir) {
    throw new AvError("SKILL_MISSING", "Skill file is missing; refusing to invent a skill");
  }
  const file = skillFilePath(computerBaseDir, tenantId, wanted);
  if (!existsSync(file)) {
    throw new AvError("SKILL_MISSING", `Skill file is missing; refusing to invent ${wanted}`);
  }
  return readSkillPath(file);
}

export function copySkillsToTrailer(skills: SkillFile[], trailerPath: string): SkillFile[] {
  const dest = path.join(trailerPath, "skills");
  mkdirSync(dest, { recursive: true });
  return skills.map((skill) => {
    const file = path.join(dest, safeName(skill.name), "SKILL.md");
    mkdirSync(path.dirname(file), { recursive: true });
    const body = skill.body.replace(/\r\n/g, "\n").trim();
    const description = skill.description.trim();
    writeFileSync(file, serializeSkillMarkdown({ name: skill.name, description, body }), "utf8");
    return { name: skill.name, description, body, path: file };
  });
}

export function serializeSkillMarkdown(skill: { name: string; description: string; body: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body.replace(/\r\n/g, "\n").trim()}\n`;
}

export function parseSkillMarkdown(raw: string): { name: string; description: string; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw skillCorrupt();
  const front = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (!body) throw skillCorrupt();
  const fields = parseFrontmatter(front);
  const name = assertSkillName(fields.name ?? "");
  const description = (fields.description ?? "").trim();
  if (!description) throw skillCorrupt();
  return { name, description, body };
}

function readSkillPath(file: string): SkillFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw skillCorrupt();
  }
  const parsed = parseSkillMarkdown(raw);
  return { ...parsed, path: file };
}

function parseFrontmatter(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) throw skillCorrupt();
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key) throw skillCorrupt();
    fields[key] = value;
  }
  return fields;
}

function assertSkillName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || safeName(trimmed) !== trimmed) {
    throw new AvError("SKILL_NAME_INVALID", "Skill name must be a single path-safe token");
  }
  return trimmed;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function skillCorrupt(): AvError {
  return new AvError("SKILL_STORE_CORRUPT", "Skill store is corrupt; refusing to invent a skill");
}
