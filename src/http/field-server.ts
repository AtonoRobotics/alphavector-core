import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRecord } from "../agents/types.js";
import type { PendingProgressRecord } from "../auth/types.js";
import { architectDeploy, fieldDeploy } from "../auth/architect-deploy.js";
import { architectDeliverMessage } from "../auth/architect-message.js";
import { AuthorizationRequiredError, AvError, DeployIncompleteError, SurfaceViolationError } from "../errors.js";
import type { AlphaVectorCore } from "../kernel.js";
import type { LoadedPack, PrincipalKind } from "../packs/types.js";
import { fieldLinuxPagePath } from "./field-boot.js";
import type {
  FieldAskBody,
  FieldFactBody,
  FieldProgressBody,
  FieldRecordAttributeRetractBody,
  FieldRecordBody,
  FieldRecordRetractBody,
  FieldRecordUpdateBody,
  FieldStartBody,
} from "./types.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
} as const;

const CONFIG_PATH =
  /model|prompt|temporal|tool|adapter-bind|adapter-credentials|credential|api-?key|routines?|mail|deadlines?|connectors?|skills?|proposals?|promote|memory|vendor-base-url|base-?url|trust-?anchors?|anchors|machine|hypervisor|images?|computer|desktop|vnc|namespace|networking|brokerage|deploy|architect[_-]?message/i;

type PendingProgress = PendingProgressRecord;

export interface FieldHttpServerOptions {
  core: AlphaVectorCore;
  pack: LoadedPack;
  tenantId: string;
  pagePath?: string;
}

/**
 * Field HTTP surface. `/field` is field-only. Architect/admin is not callable on `/field`.
 * GET `/architect/habitat` is the credential-gated habitat seat (off the field home).
 * Field users cannot configure models, prompts, Temporal, tools, trust anchors, memory stores, or the machine.
 */
export class FieldHttpServer {
  private server?: http.Server;
  private readonly pending = new Map<string, PendingProgress>();
  private restored = false;

  constructor(private readonly opts: FieldHttpServerOptions) {}

  async listen(port = 0, host = "127.0.0.1"): Promise<{ port: number; url: string }> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    return { port: addr.port, url: `http://${host}:${addr.port}` };
  }

  async close(): Promise<void> {
    this.opts.core.habitat.stopDueTicker();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === "OPTIONS") {
        this.write(res, 204, "", CORS);
        return;
      }
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        this.json(res, 200, { ok: true, surface: "field" });
        return;
      }
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        await this.servePage(res);
        return;
      }

      if (req.method === "GET" && path === "/architect/habitat") {
        this.routeArchitectHabitat(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/deploy") {
        await this.routeArchitectDeploy(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/message") {
        await this.routeArchitectMessage(req, res);
        return;
      }

      if (!path.startsWith("/field")) {
        this.json(res, 404, { error: "NOT_FOUND", message: "Not a field route" });
        return;
      }

      const principal = this.principalOf(req);
      if (!principal) {
        this.json(res, 401, { error: "UNAUTHORIZED", message: "Field token required" });
        return;
      }
      if (principal !== "field") {
        this.json(res, 403, {
          error: "SURFACE_VIOLATION",
          message: "Only a field user may use the field path",
        });
        return;
      }
      if (/deploy/i.test(path)) {
        fieldDeploy();
      }
      if (CONFIG_PATH.test(path)) {
        this.json(res, 403, {
          error: "SURFACE_VIOLATION",
          message: "Field user cannot configure models, prompts, Temporal, tools, trust anchors, or the machine",
        });
        return;
      }

      this.restorePending();
      await this.routeField(req, res, path, principal);
    } catch (err) {
      this.writeError(res, err);
    }
  }

  private async routeField(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    actor: PrincipalKind,
  ): Promise<void> {
    const { core, pack, tenantId } = this.opts;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/field/home") {
      this.json(res, 200, core.field.home(tenantId, pack));
      return;
    }

    if (method === "GET" && path === "/field/cards") {
      this.json(res, 200, { cards: core.field.listCards(tenantId) });
      return;
    }

    if (method === "POST" && path === "/field/journeys") {
      const body = (await readJson(req)) as FieldStartBody;
      const journey = core.field.start({
        actor,
        pack,
        journeyKind: String(body.journeyKind ?? ""),
        objective: String(body.objective ?? ""),
        recordId: body.recordId ? String(body.recordId) : "",
        // Claims only — never a write to the tenant fact store.
        conditions: Array.isArray(body.conditions) ? body.conditions.map(String) : undefined,
      });
      await core.habitat.observeFieldStart({
        tenantId,
        pack,
        goal: journey.objective,
        journeyId: journey.id,
        recordId: journey.recordId,
      });
      this.json(res, 201, journey);
      return;
    }

    const progress = path.match(/^\/field\/journeys\/([^/]+)\/progress$/);
    if (method === "POST" && progress) {
      const journeyId = decodeURIComponent(progress[1]!);
      const body = (await readJson(req)) as FieldProgressBody;
      await this.progress(res, actor, journeyId, body);
      return;
    }

    const approve = path.match(/^\/field\/cards\/([^/]+)\/approve$/);
    if (method === "POST" && approve) {
      await this.approve(res, actor, decodeURIComponent(approve[1]!));
      return;
    }

    const deny = path.match(/^\/field\/cards\/([^/]+)\/deny$/);
    if (method === "POST" && deny) {
      const card = core.field.resolveCard({
        actor,
        cardId: decodeURIComponent(deny[1]!),
        decision: "denied",
      });
      this.forgetPending(card.cardId);
      await core.habitat.wake({
        kind: "card_decide",
        tenantId,
        pack,
        cardId: card.cardId,
        decision: "denied",
      });
      this.json(res, 200, { cardId: card.cardId, status: card.status });
      return;
    }

    if (method === "POST" && path === "/field/facts") {
      const body = (await readJson(req)) as FieldFactBody;
      core.field.record({
        actor,
        pack,
        id: String(body.id ?? ""),
        recordId: body.recordId ? String(body.recordId) : "",
      });
      return;
    }

    if (method === "POST" && path === "/field/facts/retract") {
      const body = (await readJson(req)) as FieldFactBody;
      core.field.retract({
        actor,
        pack,
        id: String(body.id ?? ""),
        recordId: body.recordId ? String(body.recordId) : "",
      });
      return;
    }

    if (method === "POST" && path === "/field/records") {
      const body = (await readJson(req)) as FieldRecordBody;
      core.field.create({
        actor,
        pack,
        type: String(body.type ?? ""),
        label: String(body.label ?? ""),
      });
      return;
    }

    if (method === "POST" && path === "/field/records/update") {
      const body = (await readJson(req)) as FieldRecordUpdateBody;
      core.field.update({
        actor,
        pack,
        recordId: body.recordId ? String(body.recordId) : "",
        type: typeof body.type === "string" ? body.type : body.type === undefined ? undefined : "",
        label: typeof body.label === "string" ? body.label : body.label === undefined ? undefined : "",
        attributes: body.attributes,
      });
      return;
    }

    if (method === "POST" && path === "/field/records/attributes/retract") {
      const body = (await readJson(req)) as FieldRecordAttributeRetractBody;
      core.field.retractAttribute({
        actor,
        pack,
        recordId: body.recordId ? String(body.recordId) : "",
        key: body.key ? String(body.key) : "",
      });
      return;
    }

    if (method === "POST" && path === "/field/records/retract") {
      const body = (await readJson(req)) as FieldRecordRetractBody;
      core.field.retractRecord({
        actor,
        pack,
        recordId: body.recordId ? String(body.recordId) : "",
      });
      return;
    }

    if (method === "POST" && path === "/field/ask") {
      const body = (await readJson(req)) as FieldAskBody;
      core.field.ask({
        actor,
        pack,
        tenantId,
        text: String(body.text ?? ""),
        actionClass: String(body.actionClass ?? ""),
      });
      const woke = await core.habitat.wake({ kind: "field_ask", tenantId, pack });
      this.json(res, 200, {
        ok: true,
        runId: woke.run?.runId,
        memory: woke.memory,
      });
      return;
    }

    if (method === "POST" && path === "/field/continue") {
      const body = (await readJson(req)) as Record<string, unknown>;
      assertFieldContinueIsWakeOnly(body);
      const woke = await core.habitat.wake({ kind: "field_continue", tenantId, pack }, { holdWorker: true });
      this.json(res, 200, {
        ok: true,
        runId: woke.run?.runId,
        launchedWorker: woke.launchedWorker,
        memory: woke.memory,
      });
      return;
    }

    if (method === "POST" && path === "/field/kill") {
      const body = (await readJson(req)) as { reason?: string };
      const reason = String(body.reason ?? "field kill");
      core.field.kill(tenantId, reason);
      await core.habitat.wake({ kind: "kill", tenantId, reason, pack });
      this.json(res, 200, { ok: true });
      return;
    }

    this.json(res, 404, { error: "NOT_FOUND", message: "Unknown field route" });
  }

  private async progress(
    res: ServerResponse,
    actor: PrincipalKind,
    journeyId: string,
    body: FieldProgressBody,
  ): Promise<void> {
    const { core, pack, tenantId } = this.opts;
    const journey = core.store.journeys.find((j) => j.id === journeyId && j.tenantId === tenantId);
    const agent = body.actionClass ? this.boundPackAgent() : undefined;
    try {
      const result = await core.field.progress({
        actor,
        pack,
        journeyId,
        agent,
        actionClass: body.actionClass,
        channel: body.channel,
        purpose: body.purpose,
        subject: body.subject,
        to: typeof body.to === "string" ? body.to : undefined,
        body: typeof body.body === "string" ? body.body : undefined,
        from: typeof body.from === "string" ? body.from : undefined,
        note: body.note,
        ask: body.ask
          ? { tenantId, text: body.ask.text, actionClass: body.ask.actionClass }
          : undefined,
        // Claims only — never a write to the tenant fact store.
        conditions: Array.isArray(body.conditions) ? body.conditions.map(String) : undefined,
      });
      this.json(res, 200, result);
    } catch (err) {
      if (err instanceof AuthorizationRequiredError && agent && body.actionClass && journey) {
        const record: PendingProgress = {
          journeyId,
          actionClass: body.actionClass,
          channel: body.channel,
          purpose: body.purpose,
          subject: body.subject,
          ...(typeof body.to === "string" && body.to.trim() ? { to: body.to.trim() } : {}),
          ...(typeof body.body === "string" && body.body.trim() ? { body: body.body.trim() } : {}),
          ...(typeof body.from === "string" && body.from.trim() ? { from: body.from.trim() } : {}),
          agentId: agent.agentId,
          journey,
        };
        this.pending.set(err.cardId, record);
        core.cards.setPending(tenantId, err.cardId, record);
      }
      throw err;
    }
  }

  private async approve(res: ServerResponse, actor: PrincipalKind, cardId: string): Promise<void> {
    const { core, pack } = this.opts;
    const card = core.field.resolveCard({ actor, cardId, decision: "approved" });
    const fact = core.field.commitApprovedFact(cardId);
    if (fact) {
      const record = this.opts.core.records.get(this.opts.tenantId, fact.id);
      this.json(res, 200, {
        card: { cardId: card.cardId, status: card.status },
        fact,
        ...(record ? { record } : {}),
      });
      return;
    }
    const pending = this.pending.get(cardId);
    if (!pending) {
      const resumed = await core.habitat.wake({
        kind: "card_decide",
        tenantId: this.opts.tenantId,
        pack,
        cardId,
        decision: "approved",
      });
      this.json(res, 200, {
        card: { cardId: card.cardId, status: card.status },
        ...(resumed.effect ? { effect: resumed.effect } : {}),
        ...(resumed.run ? { runId: resumed.run.runId } : {}),
      });
      return;
    }
    const listed = core.agents.list(this.opts.tenantId).find((a) => a.agentId === pending.agentId);
    const worker = core.habitat.activeWorkerAgent(this.opts.tenantId);
    const agent = listed ?? (worker?.agentId === pending.agentId ? worker : undefined);
    const result = await core.field.progress({
      actor,
      pack,
      journeyId: pending.journeyId,
      agent,
      actionClass: pending.actionClass,
      channel: pending.channel,
      purpose: pending.purpose,
      subject: pending.subject,
      to: pending.to,
      body: pending.body,
      from: pending.from,
      approvedCardId: cardId,
    });
    this.forgetPending(cardId);
    this.json(res, 200, {
      card: { cardId: card.cardId, status: card.status },
      journey: result.journey,
      effect: result.effect,
    });
  }

  private restorePending(): void {
    if (this.restored) return;
    this.restored = true;
    const { core, tenantId } = this.opts;
    core.cards.hydrateTenant(tenantId);
    for (const { cardId, record } of core.cards.listPending(tenantId)) {
      this.pending.set(cardId, record);
      core.store.restoreJourney(record.journey);
    }
  }

  private forgetPending(cardId: string): void {
    this.pending.delete(cardId);
    this.opts.core.cards.clearPending(this.opts.tenantId, cardId);
  }

  /** Pack orchestrator or habitat worker. Field SHALL NOT pick an agent by name. */
  private boundPackAgent(): AgentRecord {
    const worker = this.opts.core.habitat.activeWorkerAgent(this.opts.tenantId);
    if (worker) return worker;
    const orch = this.opts.core.agents.list(this.opts.tenantId).find((a) => a.isOrchestrator);
    if (orch) return orch;
    throw new AvError("AGENT_REQUIRED", "No pack agent is bound for this tenant");
  }

  /**
   * Architect production deploy. Off `/field` and off the field HTML page.
   * Field token is 403 SURFACE_VIOLATION. Not a vendor cloud.
   * Field-serve theater (loopback / port 0 / t1) is not a deploy.
   */
  private async routeArchitectDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
      return;
    }
    const principal = this.opts.core.fieldTokens.lookup(token, this.opts.tenantId);
    if (principal === "field") {
      this.json(res, 403, {
        error: "SURFACE_VIOLATION",
        message: "Field cannot deploy; Architect is the only deployer",
      });
      return;
    }
    if (principal !== "architect") {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Unknown or revoked Architect credential" });
      return;
    }
    const body = (await readJson(req)) as { host?: string; port?: number };
    const computerBaseDir = this.opts.core.fieldTokens.baseDir();
    if (!computerBaseDir) {
      throw new DeployIncompleteError("Hull computer is not started; deploy is incomplete");
    }
    const record = await architectDeploy({
      tenantId: this.opts.tenantId,
      computerBaseDir,
      core: this.opts.core,
      host: String(body.host ?? ""),
      port: Number(body.port),
      architectToken: token,
    });
    this.json(res, 201, record);
  }

  /**
   * Architect message wake. Off `/field` and off the field HTML page.
   * Field token is 403 SURFACE_VIOLATION. Not sit().
   */
  private async routeArchitectMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
      return;
    }
    const principal = this.opts.core.fieldTokens.lookup(token, this.opts.tenantId);
    if (principal === "field") {
      this.json(res, 403, {
        error: "SURFACE_VIOLATION",
        message: "Field cannot issue architect_message",
      });
      return;
    }
    if (principal !== "architect") {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Unknown or revoked Architect credential" });
      return;
    }
    const body = (await readJson(req)) as { body?: string; addresseeId?: string };
    const computerBaseDir = this.opts.core.fieldTokens.baseDir();
    if (!computerBaseDir) {
      throw new AvError("ARCHITECT_SEAT_UNBOUND", "Architect message requires a live habitat");
    }
    const woke = await architectDeliverMessage({
      tenantId: this.opts.tenantId,
      body: String(body.body ?? ""),
      addresseeId: typeof body.addresseeId === "string" ? body.addresseeId : undefined,
      computerBaseDir,
      habitat: this.opts.core.habitat,
      architectToken: token,
    });
    this.json(res, 200, {
      ok: true,
      kind: "architect_message",
      runId: woke.run?.runId,
      wokeOrchestrator: woke.wokeOrchestrator,
      loadedAgentId: woke.memory.profile.agentId,
      memory: woke.memory,
    });
  }

  /**
   * Architect habitat seat. Off `/field` and off the field HTML page.
   * Field token is 403 SURFACE_VIOLATION. Not a named desktop or IDE.
   */
  private routeArchitectHabitat(req: IncomingMessage, res: ServerResponse): void {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
      return;
    }
    const principal = this.opts.core.fieldTokens.lookup(token, this.opts.tenantId);
    if (principal === "architect") {
      this.json(res, 200, this.opts.core.architect.sit(this.opts.tenantId));
      return;
    }
    if (principal === "field") {
      this.json(res, 403, {
        error: "SURFACE_VIOLATION",
        message: "A field token cannot sit in the habitat",
      });
      return;
    }
    this.json(res, 401, { error: "UNAUTHORIZED", message: "Unknown or revoked Architect credential" });
  }

  private principalOf(req: IncomingMessage): PrincipalKind | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return undefined;
    return this.opts.core.fieldTokens.lookup(token, this.opts.tenantId);
  }

  private async servePage(res: ServerResponse): Promise<void> {
    const pagePath = this.opts.pagePath ?? fieldLinuxPagePath();
    const raw = await readFile(pagePath, "utf8");
    this.write(res, 200, raw, { "content-type": "text/html; charset=utf-8", ...CORS });
  }

  private writeError(res: ServerResponse, err: unknown): void {
    if (err instanceof AuthorizationRequiredError) {
      this.json(res, 409, {
        error: err.code,
        message: err.message,
        cardId: err.cardId,
      });
      return;
    }
    if (err instanceof SurfaceViolationError) {
      this.json(res, 403, { error: err.code, message: err.message });
      return;
    }
    if (err instanceof AvError) {
      const status =
        err.code === "JOURNEY_NOT_FOUND" ||
          err.code === "CARD_NOT_FOUND" ||
          err.code === "AGENT_NOT_FOUND" ||
          err.code === "RECORD_NOT_FOUND" ||
          err.code === "RECORD_ATTRIBUTE_NOT_FOUND"
          ? 404
          : err.code === "POLICY_DENIED" ||
              err.code === "DENY_IS_TERMINAL" ||
              err.code === "PREDICATE_CLOSED"
            ? 403
            :             err.code === "CARD_STORE_CORRUPT" ||
                err.code === "TOKEN_STORE_CORRUPT" ||
                err.code === "FACT_STORE_CORRUPT" ||
                err.code === "RECORD_STORE_CORRUPT" ||
                err.code === "RUN_STORE_CORRUPT" ||
                err.code === "WORKER_STORE_CORRUPT" ||
                err.code === "MEMORY_STORE_CORRUPT" ||
                err.code === "ADAPTER_BIND_CORRUPT" ||
                err.code === "ADAPTER_CREDENTIALS_CORRUPT" ||
                err.code === "ROUTINE_STORE_CORRUPT" ||
                err.code === "MAIL_STORE_CORRUPT" ||
                err.code === "DEADLINE_STORE_CORRUPT" ||
                err.code === "CONNECTOR_STORE_CORRUPT" ||
                err.code === "DEPLOY_STORE_CORRUPT"
              ? 500
              : 400;
      this.json(res, status, { error: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.json(res, 500, { error: "INTERNAL", message });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    this.write(res, status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8", ...CORS });
  }

  private write(
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string>,
  ): void {
    res.writeHead(status, headers);
    res.end(body);
  }
}

/**
 * Continue is a wake. Field SHALL NOT pick who works.
 * Any agent / worker-type / assignee selector fails closed.
 */
function assertFieldContinueIsWakeOnly(body: Record<string, unknown>): void {
  const named = new Set(["agentId", "agent", "workerType", "assigneeAgentId", "assignee", "who"]);
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    const selector = named.has(key) || (lower.includes("pick") && lower.includes("agent"));
    if (selector && value !== undefined && value !== null && String(value).trim() !== "") {
      throw new AvError("FIELD_CANNOT_PICK_AGENT", "Continue is a wake; field SHALL NOT pick who works");
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}
