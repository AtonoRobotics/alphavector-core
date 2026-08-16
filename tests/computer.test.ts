import { access, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerComputerDriver } from "../src/computer/docker-driver.js";
import { planTenantNet } from "../src/computer/egress.js";
import { ComputerHost } from "../src/computer/host.js";
import { extractRootfs, stampImage } from "../src/computer/image.js";
import { resolveInsideDisk } from "../src/computer/paths.js";
import { ComputerError } from "../src/errors.js";
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

async function bootEnv(): Promise<{ host: ComputerHost; baseDir: string }> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "av-comp-"));
  const host = await ComputerHost.create({
    baseDir,
    imageCacheDir: path.join(REPO_ROOT, "images"),
  });
  hosts.push(host);
  return { host, baseDir };
}

async function boot(): Promise<ComputerHost> {
  return (await bootEnv()).host;
}

function listen(body: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
    server.on("error", reject);
  });
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
    expect(shell.exitCode, shell.stderr).toBe(0);
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

  it("readFile fails closed when a symlink would leave the tenant disk", async () => {
    const { host, baseDir } = await bootEnv();
    await host.start("tenant-a");
    const disk = path.join(baseDir, "tenants", "tenant-a", "disk");
    const outside = path.join(baseDir, "tenants", "tenant-a", "outside.txt");
    await writeFile(outside, "outside-fixture");
    await writeFile(path.join(disk, "inside.txt"), "inside-ok");
    await symlink(outside, path.join(disk, "leave"));

    await expect(host.readFile("tenant-a", "leave")).rejects.toMatchObject({
      name: "ComputerError",
      code: "PATH_ESCAPES_DISK",
      closed: true,
    });

    const inside = await host.readFile("tenant-a", "inside.txt");
    expect(inside.exists).toBe(true);
    expect(inside.content).toBe("inside-ok");
  });

  it("agent shell cat of the secrets path fails", async () => {
    const { host, baseDir } = await bootEnv();
    await host.start("tenant-a");
    const secret = "super-secret-value-xyz";
    await host.writeSecret("tenant-a", "password", secret);

    const hostSecret = path.join(baseDir, "tenants", "tenant-a", "secrets", "password");
    const diskSecretDir = path.join(baseDir, "tenants", "tenant-a", "disk", ".secrets");
    await access(hostSecret);
    await mkdir(diskSecretDir, { recursive: true });
    await writeFile(path.join(diskSecretDir, "password"), secret);

    const cat = await host.shell({
      tenantId: "tenant-a",
      agentId: "agent-one",
      argv: ["cat", "/home/.secrets/password"],
    });
    expect(cat.exitCode).not.toBe(0);
    expect(cat.stdout).not.toContain(secret);

    const leftover = await host.shell({
      tenantId: "tenant-a",
      agentId: "agent-one",
      argv: ["cat", "/home/.secrets/password"],
    });
    expect(leftover.exitCode).not.toBe(0);
    expect(leftover.stdout).not.toContain(secret);
  });

  it("empty pack egress blocks the agent computer from the network", async () => {
    const host = await boot();
    await host.start("tenant-a");
    await host.setEgress("tenant-a", { allowHosts: [] });
    const marker = "REACHED-EMPTY-EGRESS";
    const server = await listen(marker);
    try {
      const result = await host.shell({
        tenantId: "tenant-a",
        agentId: "agent-one",
        argv: [
          "sh",
          "-c",
          `wget -t 1 -T 2 -q -O - http://127.0.0.1:${server.port}/ || wget -t 1 -T 2 -q -O - http://1.1.1.1/ || true`,
        ],
      });
      expect(result.stdout).not.toContain(marker);
    } finally {
      await server.close();
    }
  });

  it("pack egress allowlist is enforced; a json file is not a wall", async () => {
    const { host, baseDir } = await bootEnv();
    await host.start("tenant-a");
    const allowed = await listen("ALLOWED-PACK-EGRESS");
    const denied = await listen("DENIED-PACK-EGRESS");
    const plan = planTenantNet(baseDir, "tenant-a");
    try {
      await host.bindPackEgress("tenant-a", [`${plan.gatewayIp}:${allowed.port}`]);

      const ok = await host.shell({
        tenantId: "tenant-a",
        agentId: "agent-one",
        argv: ["wget", "-t", "1", "-T", "3", "-q", "-O", "-", `http://${plan.gatewayIp}:${allowed.port}/`],
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("ALLOWED-PACK-EGRESS");

      const blocked = await host.shell({
        tenantId: "tenant-a",
        agentId: "agent-one",
        argv: ["wget", "-t", "1", "-T", "2", "-q", "-O", "-", `http://${plan.gatewayIp}:${denied.port}/`],
      });
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stdout).not.toContain("DENIED-PACK-EGRESS");

      await writeFile(
        path.join(baseDir, "tenants", "tenant-a", "disk", ".egress.json"),
        JSON.stringify({ allowHosts: [`${plan.gatewayIp}:${denied.port}`, "*"] }),
      );
      const still = await host.shell({
        tenantId: "tenant-a",
        agentId: "agent-one",
        argv: ["wget", "-t", "1", "-T", "2", "-q", "-O", "-", `http://${plan.gatewayIp}:${denied.port}/`],
      });
      expect(still.exitCode).not.toBe(0);
      expect(still.stdout).not.toContain("DENIED-PACK-EGRESS");
    } finally {
      await allowed.close();
      await denied.close();
    }
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

describe("tenant disk containment", () => {
  it("resolveInsideDisk keeps ordinary files and refuses a leaving symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "av-disk-"));
    const disk = path.join(root, "disk");
    await mkdir(disk);
    await writeFile(path.join(disk, "ok.txt"), "ok");
    await writeFile(path.join(root, "outside.txt"), "outside-fixture");
    await symlink(path.join(root, "outside.txt"), path.join(disk, "leave"));

    const inside = await resolveInsideDisk(disk, "ok.txt");
    expect(inside).toBe(await realpath(path.join(disk, "ok.txt")));

    await expect(resolveInsideDisk(disk, "missing.txt")).resolves.toBeUndefined();

    await expect(resolveInsideDisk(disk, "leave")).rejects.toMatchObject({
      name: "ComputerError",
      code: "PATH_ESCAPES_DISK",
      closed: true,
    });
    await expect(resolveInsideDisk(disk, "leave")).rejects.toBeInstanceOf(ComputerError);

    await expect(resolveInsideDisk(disk, "../outside.txt")).rejects.toThrow(/Refusing path/);
  });

  it("docker driver readFile uses the same containment check", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "av-dock-"));
    const disk = path.join(baseDir, "tenants", "tenant-a", "disk");
    await mkdir(disk, { recursive: true });
    await writeFile(path.join(disk, "ok.txt"), "ok");
    await writeFile(path.join(baseDir, "tenants", "tenant-a", "outside.txt"), "outside-fixture");
    await symlink(path.join(baseDir, "tenants", "tenant-a", "outside.txt"), path.join(disk, "leave"));

    const driver = new DockerComputerDriver(baseDir);
    const inside = await driver.readFile("tenant-a", "ok.txt");
    expect(inside.exists).toBe(true);
    expect(inside.content).toBe("ok");

    await expect(driver.readFile("tenant-a", "leave")).rejects.toMatchObject({
      name: "ComputerError",
      code: "PATH_ESCAPES_DISK",
      closed: true,
    });
  });
});
