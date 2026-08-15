import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerHost } from "../src/computer/host.js";
import { dockerAvailable, ProcessDockerRunner } from "../src/computer/docker.js";
import { PRODUCT } from "../src/product.js";

const runner = new ProcessDockerRunner();
const host = new ComputerHost({ runner });
const tenantId = `comp_${Date.now()}`;
const agentA = "agent-intake-1";
const agentB = "agent-analyst-1";
const egress = { hosts: ["outbox.example.test"] };

const dockerOk = await dockerAvailable(runner);

describe.skipIf(!dockerOk)("computer start / persist / update-keeps-disk", () => {
  beforeAll(async () => {
    await host.ensureImage();
    await host.startTenantComputer({ tenantId, egress });
    await host.attachDesktop(tenantId, agentA);
    await host.attachDesktop(tenantId, agentB);
  }, 600_000);

  afterAll(async () => {
    await host.destroyTenant(tenantId);
  });

  it("starts one Linux computer per tenant and lets an agent use shell and files", async () => {
    const written = await host.execShell(
      tenantId,
      agentA,
      "printf 'shared-disk\\n' > /tenant/home/from-a.txt && cat /tenant/home/from-a.txt",
    );
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("shared-disk");
    const file = await host.readFile(tenantId, "/tenant/home/from-a.txt");
    expect(file.exists).toBe(true);
    expect(file.type).toBe("file");
    expect(file.content).toContain("shared-disk");
    expect(file.sha256).toBeTruthy();
  });

  it("lets a second agent on the same tenant see the same disk", async () => {
    const seen = await host.execShell(tenantId, agentB, "cat /tenant/home/from-a.txt");
    expect(seen.exitCode).toBe(0);
    expect(seen.stdout).toContain("shared-disk");
    const file = await host.readFile(tenantId, "/tenant/home/from-a.txt");
    expect(file.content).toContain("shared-disk");
  });

  it("keeps desktops separate while sharing the machine", async () => {
    const desktopA = host.desktopOf(tenantId, agentA);
    const desktopB = host.desktopOf(tenantId, agentB);
    expect(desktopA?.display).toBeDefined();
    expect(desktopB?.display).toBeDefined();
    expect(desktopA?.display).not.toBe(desktopB?.display);
    const shotA = await host.screenshot(tenantId, agentA);
    const shotB = await host.screenshot(tenantId, agentB);
    expect(shotA.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(shotB.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(host.screenshotDigest(shotA)).not.toBe(host.screenshotDigest(shotB));
    const displayEnv = await host.execShell(tenantId, agentA, "printf '%s' \"${DISPLAY:-unset}\"");
    expect(displayEnv.stdout.trim()).toBe("unset");
  });

  it("keeps files across a data-preserving image update", async () => {
    await host.writeTenantFile(tenantId, "/tenant/home/keep-me.txt", "login-cookie-and-notes");
    await runner.run(["tag", host.imageRef(), `${PRODUCT.computerImage}:0.1.1`]);
    const update = await host.updateImage(tenantId, "0.1.1", egress);
    expect(update.volumePreserved).toBe(true);
    expect(update.sampleStillPresent).toBe(true);
    const kept = await host.readFile(tenantId, "/tenant/home/keep-me.txt");
    expect(kept.exists).toBe(true);
    expect(kept.content).toBe("login-cookie-and-notes");
    const fromA = await host.readFile(tenantId, "/tenant/home/from-a.txt");
    expect(fromA.content).toContain("shared-disk");
  });
});

describe("computer runtime requirement", () => {
  it("documents that the computer is a real Linux image, not an in-process mock", () => {
    expect(PRODUCT.computerImage).toBe("llc.alphavector.dev/computer");
    expect(host.imageRef()).toContain("llc.alphavector.dev/computer");
  });
});
