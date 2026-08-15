import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { AvError } from "./errors.js";
import { createKernel, fixturePackFor, type Kernel } from "./kernel.js";
import { StaticCounselBinder } from "./policy/counsel-binder.js";
import { PolicyGateway } from "./policy/gateway.js";
import { architectHtml, askHtml, fieldHomeHtml } from "./surfaces/html.js";
import { PRODUCT } from "./product.js";
import { egressFromPack } from "./computer/egress.js";
import { assertSurfaceAccess } from "./principals/guard.js";

export async function buildApp(kernel: Kernel = createKernel()) {
  const app = Fastify({ logger: true });
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/web/",
  });

  app.get("/health", async () => ({
    ok: true,
    product: PRODUCT,
  }));

  app.get("/", async (request, reply) => {
    assertSurfaceAccess(principalFrom(request, kernel), "field");
    return reply.type("text/html").send(fieldHomeHtml());
  });

  app.get("/ask", async (request, reply) => {
    assertSurfaceAccess(principalFrom(request, kernel), "ask");
    return reply.type("text/html").send(askHtml());
  });

  app.get("/architect", async (request, reply) => {
    assertSurfaceAccess(principalFrom(request, kernel), "architect");
    return reply.type("text/html").send(architectHtml());
  });

  app.get("/api/field/state", async (request) => {
    const principal = principalFrom(request, kernel);
    assertSurfaceAccess(principal, "field");
    try {
      const pack = await kernel.packLoader.active(kernel.tenantId);
      return {
        surface: "field",
        language: pack.document.fieldLanguageMap,
        journeyKinds: pack.document.journeyKinds,
        architectCards: [],
      };
    } catch {
      return { surface: "field", language: {}, journeyKinds: [], architectCards: [] };
    }
  });

  app.post("/api/ask", async (request) => {
    const principal = principalFrom(request, kernel);
    assertSurfaceAccess(principal, "ask");
    const pack = await kernel.packLoader.active(kernel.tenantId);
    const body = request.body as { text?: string };
    return {
      surface: "ask",
      ceilings: pack.document.askCeilings,
      reply:
        "Ask is optional and ceiling-bound. It cannot load packs, spawn agents, or authorize external effects.",
      echo: body.text ?? "",
    };
  });

  app.post("/api/architect/packs/load-fixture", async (request) => {
    const principal = principalFrom(request, kernel);
    assertSurfaceAccess(principal, "architect");
    const document = fixturePackFor(kernel);
    const loaded = await kernel.packLoader.load({
      tenantId: kernel.tenantId,
      principal,
      document,
    });
    const counsel = kernel.issueFixtureCounsel(loaded);
    kernel.gateway = new PolicyGateway(new StaticCounselBinder(counsel));
    const spawned = await kernel.spawner.spawnFromPack({
      tenantId: kernel.tenantId,
      principal,
      pack: loaded,
    });
    return {
      pack: loaded.document.identity,
      agents: spawned.agents.map((agent) => ({ name: agent.name, roleId: agent.roleId })),
    };
  });

  app.post("/api/architect/computer/start", async (request) => {
    const principal = principalFrom(request, kernel);
    assertSurfaceAccess(principal, "architect");
    const pack = await kernel.packLoader.active(kernel.tenantId);
    const computer = await kernel.computer.startTenantComputer({
      tenantId: kernel.tenantId,
      egress: egressFromPack(pack),
    });
    return computer;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AvError) {
      return reply.status(error.closed ? 403 : 400).send({
        error: error.code,
        message: error.message,
        closed: error.closed,
      });
    }
    requestLog(error);
    return reply.status(500).send({ error: "INTERNAL", message: "closed" });
  });

  return { app, kernel };
}

function principalFrom(request: { headers: Record<string, unknown> }, kernel: Kernel) {
  const kind = String(request.headers["x-av-principal"] ?? "field_user");
  return kind === "architect" ? kernel.principals.architect : kernel.principals.field;
}

function requestLog(error: unknown): void {
  const digest = createHash("sha256").update(String(error)).digest("hex").slice(0, 8);
  console.error(`av-dev error ${digest}`);
}
