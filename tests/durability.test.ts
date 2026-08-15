import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";
import { ComputerHost } from "../src/computer/host.js";
import { FilePackRegistry } from "../src/packs/file-registry.js";
import { PackLoader } from "../src/packs/loader.js";
import { REPO_ROOT, signedGenericPack } from "./helpers.js";

const hosts: ComputerHost[] = [];

afterEach(async () => {
  for (const host of hosts) {
    try {
      await host.stop("tenant-a");
    } catch {
      // ignore
    }
  }
  hosts.length = 0;
});

describe("durable pack registry", () => {
  it("reloads the active pack from disk in a new process-equivalent loader", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-packs-"));
    const { anchors, binding } = await signedGenericPack();
    const first = new PackLoader(new FilePackRegistry(dir), anchors);
    const loaded = first.load({ tenantId: "t1", binding, actor: "architect" });
    expect(loaded.ok).toBe(true);

    const second = new PackLoader(new FilePackRegistry(dir), anchors);
    const active = second.active("t1");
    expect(active.binding.identity.packId).toBe("av-fixture-generic");
    expect(active.binding.roles).toHaveLength(binding.roles.length);
  });
});

describe("durable running-state", () => {
  it("rehydrates instantiated agents from disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-agents-"));
    const { anchors, binding } = await signedGenericPack();
    const { MemoryPackRegistry } = await import("../src/packs/loader.js");
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const loaded = loader.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);

    const first = new AgentRuntime(dir);
    const created = first.instantiateFromPack(loaded.loaded, "architect");
    expect(created.length).toBeGreaterThan(1);

    const second = new AgentRuntime(dir);
    const names = second.list("t1").map((a) => a.name).sort();
    expect(names).toEqual(created.map((a) => a.name).sort());
    expect(second.getByName("t1", created[0]!.name).persona).toBe(created[0]!.persona);
  });

  it("rehydrates a running tenant computer from the same baseDir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-run-"));
    const first = await ComputerHost.create({
      baseDir: dir,
      imageCacheDir: path.join(REPO_ROOT, "images"),
    });
    hosts.push(first);
    await first.start("tenant-a");
    await first.shell({
      tenantId: "tenant-a",
      agentId: "researcher",
      argv: ["sh", "-c", "echo persisted > /home/keep-runtime.txt"],
    });

    const second = await ComputerHost.create({
      baseDir: dir,
      imageCacheDir: path.join(REPO_ROOT, "images"),
    });
    hosts.push(second);
    const status = await second.driver.status("tenant-a");
    expect(status?.status).toBe("running");
    const file = await second.readFile("tenant-a", "keep-runtime.txt");
    expect(file.exists).toBe(true);
    expect(file.content?.trim()).toBe("persisted");
  });
});
