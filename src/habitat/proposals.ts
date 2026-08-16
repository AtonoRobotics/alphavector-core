import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import type { ProposalFile, ProposalKind } from "./types.js";

/**
 * Habitat-written proposals on tenant disk (HK-071 / DEC-013).
 * A proposal is a skill draft or a strategy note. It is not a skill.
 * It is not loaded on the next wake. It is not policy.
 *
 * Same class as skills / memory / cards: beside disk/, never inside the
 * bind-mounted /home. Field SHALL NOT add, author, upload, or promote.
 * Promotion is Architect + eval only — not this store.
 */

export function proposalFilePath(computerBaseDir: string, tenantId: string, name: string): string {
  return path.join(computerRoot(computerBaseDir, tenantId).proposalsDir, safeName(name), "PROPOSAL.md");
}

export function writeProposalFile(
  computerBaseDir: string,
  tenantId: string,
  proposal: { name: string; kind: ProposalKind; description: string; body: string },
): ProposalFile {
  const name = assertProposalName(proposal.name);
  const kind = assertProposalKind(proposal.kind);
  const description = proposal.description.trim();
  const body = proposal.body.replace(/\r\n/g, "\n").trim();
  if (!description) {
    throw new AvError("PROPOSAL_INCOMPLETE", "Proposal write requires a description");
  }
  if (!body) {
    throw new AvError("PROPOSAL_INCOMPLETE", "Proposal write requires a body");
  }
  const file = proposalFilePath(computerBaseDir, tenantId, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeProposalMarkdown({ name, kind, description, body }), "utf8");
  return { name, kind, description, body, path: file, isSkill: false, isPolicy: false };
}

/**
 * Load every habitat-written proposal on the tenant computer.
 * Missing store (no proposals dir) is empty — habitat has not written yet.
 * Incomplete, unsigned, or unparseable PROPOSAL.md fails closed.
 * Does not invent files. Does not load live skills.
 */
export function loadProposalFiles(computerBaseDir: string | undefined, tenantId: string): ProposalFile[] {
  if (!computerBaseDir) return [];
  const dir = computerRoot(computerBaseDir, tenantId).proposalsDir;
  if (!existsSync(dir)) return [];
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    throw proposalCorrupt();
  }
  if (!st.isDirectory()) throw proposalCorrupt();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw proposalCorrupt();
  }
  const loaded: ProposalFile[] = [];
  for (const entry of names.sort()) {
    const child = path.join(dir, entry);
    let childSt: ReturnType<typeof statSync>;
    try {
      childSt = statSync(child);
    } catch {
      throw proposalCorrupt();
    }
    if (!childSt.isDirectory()) continue;
    const file = path.join(child, "PROPOSAL.md");
    if (!existsSync(file)) {
      throw new AvError(
        "PROPOSAL_INCOMPLETE",
        `Proposal file is missing; refusing to invent ${entry}`,
      );
    }
    loaded.push(readProposalPath(file));
  }
  return loaded;
}

/** Read one named proposal. Missing, unsigned, or incomplete fails closed. */
export function readProposalFile(
  computerBaseDir: string | undefined,
  tenantId: string,
  name: string,
): ProposalFile {
  const wanted = assertProposalName(name);
  if (!computerBaseDir) {
    throw new AvError("PROPOSAL_MISSING", "Proposal file is missing; refusing to invent a proposal");
  }
  const file = proposalFilePath(computerBaseDir, tenantId, wanted);
  if (!existsSync(file)) {
    throw new AvError("PROPOSAL_MISSING", `Proposal file is missing; refusing to invent ${wanted}`);
  }
  return readProposalPath(file);
}

/**
 * A proposal is not policy. Unsigned or incomplete proposals fail closed
 * and do not become policy. Habitat and field cannot treat a draft as policy.
 */
export function assertProposalNotPolicy(proposal: ProposalFile): void {
  if (proposal.isPolicy !== false || proposal.isSkill !== false) {
    throw new AvError("PROPOSAL_NOT_POLICY", "A proposal is not policy; refusing to treat a draft as policy");
  }
}

export function serializeProposalMarkdown(proposal: {
  name: string;
  kind: ProposalKind;
  description: string;
  body: string;
}): string {
  return `---\nname: ${proposal.name}\nkind: ${proposal.kind}\ndescription: ${proposal.description}\npolicy: false\n---\n\n${proposal.body.replace(/\r\n/g, "\n").trim()}\n`;
}

export function parseProposalMarkdown(raw: string): {
  name: string;
  kind: ProposalKind;
  description: string;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw proposalUnsignedOrIncomplete();
  const front = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (!body) throw proposalUnsignedOrIncomplete();
  const fields = parseFrontmatter(front);
  const name = assertProposalName(fields.name ?? "");
  const kind = assertProposalKind(fields.kind ?? "");
  const description = (fields.description ?? "").trim();
  if (!description) throw proposalUnsignedOrIncomplete();
  if (fields.policy !== "false") {
    throw new AvError(
      "PROPOSAL_NOT_POLICY",
      "Unsigned or incomplete proposals fail closed and do not become policy",
    );
  }
  return { name, kind, description, body };
}

function readProposalPath(file: string): ProposalFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw proposalCorrupt();
  }
  const parsed = parseProposalMarkdown(raw);
  return { ...parsed, path: file, isSkill: false, isPolicy: false };
}

function parseFrontmatter(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) throw proposalUnsignedOrIncomplete();
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key) throw proposalUnsignedOrIncomplete();
    fields[key] = value;
  }
  return fields;
}

function assertProposalName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || safeName(trimmed) !== trimmed) {
    throw new AvError("PROPOSAL_NAME_INVALID", "Proposal name must be a single path-safe token");
  }
  return trimmed;
}

function assertProposalKind(kind: string): ProposalKind {
  const trimmed = kind.trim();
  if (trimmed === "skill_draft" || trimmed === "strategy") return trimmed;
  throw new AvError("PROPOSAL_INCOMPLETE", "Proposal kind must be skill_draft or strategy");
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function proposalCorrupt(): AvError {
  return new AvError("PROPOSAL_STORE_CORRUPT", "Proposal store is corrupt; refusing to invent a proposal");
}

function proposalUnsignedOrIncomplete(): AvError {
  return new AvError(
    "PROPOSAL_INCOMPLETE",
    "Unsigned or incomplete proposals fail closed and do not become policy",
  );
}
