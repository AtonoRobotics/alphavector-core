import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { writeJsonAtomic } from "../persist/json-file.js";
import type { WorkerBrief } from "./types.js";

/**
 * Kernel-written worker brief (HK-030).
 * Control artifact beside workers.json, plus a copy next to the booked
 * trailer so the worker pass reads the same bytes the isolation holds.
 * A string on CognitiveIntent is not a brief. Field SHALL NOT write this.
 */

export interface BriefRecord {
  workerId: string;
  runId: string;
  body: string;
  writtenAt: string;
  writtenBy: "kernel";
}

export function briefControlPath(computerBaseDir: string, tenantId: string, workerId: string): string {
  return path.join(computerRoot(computerBaseDir, tenantId).briefsDir, `${workerId}.json`);
}

export function pendingBriefPath(computerBaseDir: string, tenantId: string): string {
  return path.join(computerRoot(computerBaseDir, tenantId).briefsDir, "pending.json");
}

export function trailerBriefPath(trailerPath: string): string {
  return path.join(trailerPath, "brief.json");
}

export function writeBriefRecord(file: string, record: BriefRecord): void {
  writeJsonAtomic(file, record);
}

export function writeTrailerBrief(trailerPath: string, record: BriefRecord): string {
  mkdirSync(trailerPath, { recursive: true });
  const file = trailerBriefPath(trailerPath);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

export function readBriefRecord(file: string): BriefRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new AvError("BRIEF_CORRUPT", "Worker brief is corrupt; refusing to invent a brief");
  }
  return parseBrief(raw);
}

export function readBriefFile(file: string): BriefRecord | undefined {
  if (!existsSync(file)) return undefined;
  return readBriefRecord(file);
}

export function loadWorkerBrief(input: {
  computerBaseDir?: string;
  tenantId: string;
  workerId: string;
  trailerPath?: string;
}): WorkerBrief | undefined {
  if (!input.computerBaseDir) return undefined;
  const trailerFile = input.trailerPath ? trailerBriefPath(input.trailerPath) : undefined;
  const controlFile = briefControlPath(input.computerBaseDir, input.tenantId, input.workerId);
  const file = trailerFile && existsSync(trailerFile) ? trailerFile : controlFile;
  const record = readBriefFile(file);
  if (!record) return undefined;
  if (record.workerId !== input.workerId) {
    throw new AvError("BRIEF_CORRUPT", "Worker brief does not address the booked worker");
  }
  return { ...record, path: file };
}

export function persistWorkerBrief(input: {
  computerBaseDir: string;
  tenantId: string;
  workerId: string;
  runId: string;
  body: string;
  writtenAt: string;
  trailerPath?: string;
}): WorkerBrief {
  const record: BriefRecord = {
    workerId: input.workerId,
    runId: input.runId,
    body: input.body,
    writtenAt: input.writtenAt,
    writtenBy: "kernel",
  };
  const control = briefControlPath(input.computerBaseDir, input.tenantId, input.workerId);
  writeBriefRecord(control, record);
  const file = input.trailerPath ? writeTrailerBrief(input.trailerPath, record) : control;
  return { ...record, path: file };
}

export function persistPendingBrief(input: {
  computerBaseDir: string;
  tenantId: string;
  runId: string;
  body: string;
  writtenAt: string;
}): BriefRecord {
  const record: BriefRecord = {
    workerId: "",
    runId: input.runId,
    body: input.body,
    writtenAt: input.writtenAt,
    writtenBy: "kernel",
  };
  writeBriefRecord(pendingBriefPath(input.computerBaseDir, input.tenantId), record);
  return record;
}

export function peekPendingBrief(computerBaseDir: string | undefined, tenantId: string): BriefRecord | undefined {
  if (!computerBaseDir) return undefined;
  return readBriefFile(pendingBriefPath(computerBaseDir, tenantId));
}

export function takePendingBrief(computerBaseDir: string | undefined, tenantId: string): BriefRecord | undefined {
  const record = peekPendingBrief(computerBaseDir, tenantId);
  if (!record || !computerBaseDir) return record;
  const file = pendingBriefPath(computerBaseDir, tenantId);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // attached copy is the artifact; leftover pending is not a second brief
    }
  }
  return record;
}

function parseBrief(raw: unknown): BriefRecord {
  if (
    !isRecord(raw) ||
    typeof raw.workerId !== "string" ||
    typeof raw.runId !== "string" ||
    !raw.runId ||
    typeof raw.body !== "string" ||
    typeof raw.writtenAt !== "string" ||
    !raw.writtenAt ||
    raw.writtenBy !== "kernel"
  ) {
    throw new AvError("BRIEF_CORRUPT", "Worker brief is corrupt; refusing to invent a brief");
  }
  return {
    workerId: raw.workerId,
    runId: raw.runId,
    body: raw.body,
    writtenAt: raw.writtenAt,
    writtenBy: "kernel",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
