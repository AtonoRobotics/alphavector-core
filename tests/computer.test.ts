import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerHost } from "../src/computer/host.js";
import { extractRootfs, stampImage } from "../src/computer/image.js";
import { REPO_ROOT } from "./helpers.js";

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

async function boot(): Promise<ComputerHost> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "av-comp-"));
  const host = await ComputerHost.create({
    baseDir: dir,
    imageCacheDir: path.join(REPO_ROOT, "images"),
  });
  hosts.push(host);
  return host;
}

describe("computer primitive", () => {
  it("starts a real Linux computer for a tenant", async () => {
    const host = await boot();
    const computer = await host.start("tenant-a");
    expect(computer.status).toBe("running");
    expect(computer.sharedFilesystem).toBe(true);
    const shell = await host.shell({
      tenantId: "tenant-a",
      agentId: "agent-one",
      argv: ["cat", "/etc/os-release"],
    });
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.toLowerCase()).toContain("alpine");
  });

  it("two agents share the disk and have separate desktops", async () => {
    const host = await boot();
    await host.start("tenant-a");
    const write = await host.shell({
      tenantId: "tenant-a",
      agentId: "researcher",
      argv: ["sh", "-c", "echo shared-secret > /home/shared.txt"],
    });
    expect(write.exitCode).toBe(0);
    const read = await host.shell({
      tenantId: "tenant-a",
      agentId: "writer",
      argv: ["cat", "/home/shared.txt"],
    });
    expect(read.stdout.trim()).toBe("shared-secret");

    const file = await host.readFile("tenant-a", "shared.txt");
    expect(file.exists).toBe(true);
    expect(file.content?.trim()).toBe("shared-secret");

    const deskA = await host.ensureDesktop("tenant-a", "researcher");
    const deskB = await host.ensureDesktop("tenant-a", "writer");
    expect(deskA.display).not.toBe(deskB.display);
    expect(deskA.desktopPath).not.toBe(deskB.desktopPath);

    const shotA = await host.screenshot("tenant-a", "researcher");
    const shotB = await host.screenshot("tenant-a", "writer");
    expect(shotA.mime).toBe("image/png");
    expect(shotB.mime).toBe("image/png");
    expect(shotA.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(shotB.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(shotA.bytes.equals(shotB.bytes)).toBe(false);
    expect(deskA.viewerPath).toContain("viewer.html");
    expect(deskB.viewerPath).toContain("viewer.html");
    expect(deskA.vncPort).not.toBe(deskB.vncPort);
  });

  it("image update keeps files on disk", async () => {
    const host = await boot();
    await host.start("tenant-a");
    await host.shell({
      tenantId: "tenant-a",
      agentId: "researcher",
      argv: ["sh", "-c", "echo keep-me > /home/keep.txt && mkdir -p /home/.config/browser && echo cookie > /home/.config/browser/login"],
    });
    const before = await host.driver.status("tenant-a");
    expect(before?.imageId).toBeTruthy();

    const tmp = await mkdtemp(path.join(os.tmpdir(), "av-img-"));
    const tarball = path.join(REPO_ROOT, "images", "alpine-minirootfs-3.20.3-x86_64.tar.gz");
    const newRoot = path.join(tmp, "rootfs");
    await extractRootfs(tarball, newRoot);
    await stampImage(newRoot, "alpine-3.20.3-av-computer-rebuilt");
    await writeFile(path.join(newRoot, "etc", "av-rebuild"), "yes\n");

    const updated = await host.updateImage("tenant-a", {
      imageId: "alpine-3.20.3-av-computer-rebuilt",
      source: newRoot,
    });
    expect(updated.imageId).toBe("alpine-3.20.3-av-computer-rebuilt");
    expect(updated.imageId).not.toBe(before?.imageId);

    const kept = await host.readFile("tenant-a", "keep.txt");
    expect(kept.exists).toBe(true);
    expect(kept.content?.trim()).toBe("keep-me");
    const login = await host.readFile("tenant-a", ".config/browser/login");
    expect(login.exists).toBe(true);
    expect(login.content?.trim()).toBe("cookie");

    const imageCheck = await host.shell({
      tenantId: "tenant-a",
      agentId: "researcher",
      argv: ["cat", "/etc/av-image-id"],
    });
    expect(imageCheck.stdout.trim()).toBe("alpine-3.20.3-av-computer-rebuilt");
  });

  it("agent file read cannot see secrets", async () => {
    const host = await boot();
    await host.start("tenant-a");
    await host.writeSecret("tenant-a", "password", "hunter2");
    await expect(host.readFile("tenant-a", ".secrets/password")).rejects.toThrow(/never sees passwords/);
  });

  it("architect can attach to an agent desktop", async () => {
    const host = await boot();
    await host.start("tenant-a");
    const session = await host.architectAttach("tenant-a", "writer");
    expect(session.agentId).toBe("writer");
    expect(session.desktopPath).toContain("writer");
    expect(session.viewerPath).toContain("viewer.html");
    expect(session.vncPort).toBeGreaterThan(0);
    const html = await (await import("node:fs/promises")).readFile(session.viewerPath, "utf8");
    expect(html).toContain("Architect attach");
    expect(html).toContain("writer");
  });
});
