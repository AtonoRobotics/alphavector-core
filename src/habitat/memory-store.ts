import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { AgentProfile, DatedLogEntry, LabeledMemory, RecallItem } from "./types.js";

/**
 * CS-012 memory on tenant disk: per-agent profile, dated logs, scoped recall JSON.
 * This is habitat memory. The in-process MemoryTiers array is not the store.
 * Memory SHALL NOT become fact, consent, or outcome.
 */
export class HabitatMemoryStore {
  constructor(private readonly computerBaseDir?: string) {}

  writeProfile(input: { tenantId: string; agentId: string; note: string }): AgentProfile {
    const current = this.loadProfile(input.tenantId, input.agentId) ?? {
      agentId: input.agentId,
      tenantId: input.tenantId,
      notes: [],
      updatedAt: nowIso(),
    };
    current.notes.push(input.note);
    current.updatedAt = nowIso();
    this.writeJson(this.profileFile(input.tenantId, input.agentId), current);
    return current;
  }

  writeLog(input: { tenantId: string; agentId: string; text: string; date?: string }): DatedLogEntry {
    const date = input.date ?? nowIso().slice(0, 10);
    const entry: DatedLogEntry = {
      logId: newId("log"),
      agentId: input.agentId,
      tenantId: input.tenantId,
      date,
      text: input.text,
      createdAt: nowIso(),
      isFact: false,
    };
    const file = this.logFile(input.tenantId, input.agentId, date);
    const existing = this.readJson<DatedLogEntry[]>(file) ?? [];
    existing.push(entry);
    this.writeJson(file, existing);
    return entry;
  }

  writeRecall(input: {
    tenantId: string;
    scope: RecallItem["scope"];
    subjectId: string;
    text: string;
  }): RecallItem {
    const item: RecallItem = {
      recallId: newId("recall"),
      scope: input.scope,
      subjectId: input.subjectId,
      text: input.text,
      createdAt: nowIso(),
      isFact: false,
    };
    const file = this.recallFile(input.tenantId, input.scope, input.subjectId);
    const existing = this.readJson<RecallItem[]>(file) ?? [];
    existing.push(item);
    this.writeJson(file, existing);
    return item;
  }

  loadProfile(tenantId: string, agentId: string): AgentProfile | undefined {
    return this.readJson<AgentProfile>(this.profileFile(tenantId, agentId));
  }

  loadLogs(tenantId: string, agentId: string): DatedLogEntry[] {
    const dir = path.join(this.memoryRoot(tenantId), "logs", agentId);
    const files = this.listJsonFiles(dir);
    const entries: DatedLogEntry[] = [];
    for (const file of files) {
      const rows = this.readJson<DatedLogEntry[]>(file) ?? [];
      entries.push(...rows);
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  loadRecall(tenantId: string, scope: RecallItem["scope"], subjectId: string): RecallItem[] {
    return this.readJson<RecallItem[]>(this.recallFile(tenantId, scope, subjectId)) ?? [];
  }

  /**
   * HK-051 / HK-072: labeled memory for the next pass. Not an unlabeled blob.
   */
  labeled(tenantId: string, agentId: string): LabeledMemory {
    const recallScope = `agent:${agentId}`;
    return {
      profile: {
        label: "profile",
        agentId,
        body: this.loadProfile(tenantId, agentId) ?? null,
      },
      logs: { label: "logs", agentId, entries: this.loadLogs(tenantId, agentId) },
      recall: {
        label: "recall",
        scope: recallScope,
        items: this.loadRecall(tenantId, "agent", agentId),
      },
    };
  }

  promoteToFact(_id: string): never {
    throw new AvError("MEMORY_NOT_FACT", "Memory SHALL NOT become verified facts, consent, or outcomes");
  }

  private memoryRoot(tenantId: string): string {
    if (!this.computerBaseDir) {
      throw new AvError("MEMORY_DISK_REQUIRED", "Habitat memory lives on tenant disk");
    }
    return computerRoot(this.computerBaseDir, tenantId).memoryDir;
  }

  private profileFile(tenantId: string, agentId: string): string {
    return path.join(this.memoryRoot(tenantId), "profiles", `${agentId}.json`);
  }

  private logFile(tenantId: string, agentId: string, date: string): string {
    return path.join(this.memoryRoot(tenantId), "logs", agentId, `${date}.json`);
  }

  private recallFile(tenantId: string, scope: string, subjectId: string): string {
    return path.join(this.memoryRoot(tenantId), "recall", `${scope}-${subjectId}.json`);
  }

  private readJson<T>(file: string): T | undefined {
    if (!this.computerBaseDir) return undefined;
    try {
      return readJsonFileStrict<T>(file);
    } catch {
      throw new AvError("MEMORY_STORE_CORRUPT", "Memory store is corrupt; refusing to invent memory");
    }
  }

  private writeJson(file: string, value: unknown): void {
    if (!this.computerBaseDir) {
      throw new AvError("MEMORY_DISK_REQUIRED", "Habitat memory lives on tenant disk");
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, value);
  }

  private listJsonFiles(dir: string): string[] {
    if (!this.computerBaseDir) return [];
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }
}
