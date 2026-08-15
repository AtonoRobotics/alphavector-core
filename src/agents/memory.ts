import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { MemoryEntry } from "./types.js";

export class MemoryTiers {
  private readonly entries: MemoryEntry[] = [];

  write(input: {
    tenantId: string;
    tier: MemoryEntry["tier"];
    subjectId: string;
    text: string;
  }): MemoryEntry {
    const entry: MemoryEntry = {
      memoryId: newId("mem"),
      tenantId: input.tenantId,
      tier: input.tier,
      subjectId: input.subjectId,
      text: input.text,
      createdAt: nowIso(),
      isFact: false,
    };
    this.entries.push(entry);
    return entry;
  }

  list(tenantId: string, tier?: MemoryEntry["tier"], subjectId?: string): MemoryEntry[] {
    return this.entries.filter(
      (e) =>
        e.tenantId === tenantId &&
        (tier ? e.tier === tier : true) &&
        (subjectId ? e.subjectId === subjectId : true),
    );
  }

  promoteToFact(_memoryId: string): never {
    throw new AvError("MEMORY_NOT_FACT", "Memory SHALL NOT become verified facts, consent, or outcomes");
  }
}
