import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRecord } from "../agents/types.js";
import type { PendingProgressRecord } from "../auth/types.js";
import { architectBindAdapter, architectEditAdapterBind } from "../auth/architect-adapter-bind.js";
import { architectWriteAdapterAggregator } from "../auth/architect-adapter-aggregator.js";
import { architectWriteAdapterCredentials } from "../auth/architect-adapter-credentials.js";
import {
  architectCompleteSubscriptionAuth,
  architectStartSubscriptionAuth,
  MemorySubscriptionAuthHold,
} from "../auth/architect-subscription-auth.js";
import {
  architectCompleteConnectorAuth,
  architectStartConnectorAuth,
  MemoryConnectorAuthHold,
} from "../auth/architect-connector-auth.js";
import { architectWriteAdapterRouter } from "../auth/architect-adapter-router.js";
import {
  architectBindConnector,
  architectEditConnectorBind,
  architectWriteConnectorCredentials,
} from "../auth/architect-connectors.js";
import { architectDeploy, fieldDeploy } from "../auth/architect-deploy.js";
import { architectSit } from "../auth/architect-habitat.js";
import { architectDeliverMessage } from "../auth/architect-message.js";
import { AuthorizationRequiredError, AvError, DeployIncompleteError, SurfaceViolationError } from "../errors.js";
import type { AlphaVectorCore } from "../kernel.js";
import type { LoadedPack, PrincipalKind } from "../packs/types.js";
import { readTenantAdapterAggregator } from "../habitat/adapter-aggregator.js";
import { readTenantAdapterBinds } from "../habitat/adapter-bind.js";
import { readTenantAdapterRouter } from "../habitat/adapter-router.js";
import { readTenantConnectorBinds } from "../habitat/connector-bind.js";
import {
  parseGlmAuthorizationCallback,
  receiveGlmAuthorizationCode,
} from "../habitat/vendor-login.js";
import { architectHabitatPageHtml, wantsArchitectHabitatHtml } from "./architect-habitat-page.js";
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
  /model|prompt|temporal|tool|adapter-bind|adapter-credentials|adapter-router|adapter-aggregator|bind-adapter|set-adapter-credentials|set-adapter-router|set-adapter-aggregator|edit-adapter-bind|edit-connector-bind|bind-connector|set-connector-credentials|credential|api-?key|routines?|mail|deadlines?|connectors?|skills?|proposals?|promote|memory|vendor-base-url|base-?url|trust-?anchors?|anchors|machine|hypervisor|images?|computer|desktop|vnc|namespace|networking|brokerage|deploy|architect[_-]?message|router|aggregator|subscription-auth|start-subscription|complete-subscription|start-connector-auth|complete-connector-auth/i;

type PendingProgress = PendingProgressRecord;

export interface FieldHttpServerOptions {
  core: AlphaVectorCore;
  pack: LoadedPack;
  tenantId: string;
  pagePath?: string;
}

/**
 * Field HTTP surface. `/field` is field-only. Architect/admin is not callable on `/field`.
 * GET `/architect/habitat` JSON is the credential-gated habitat seat (off the field home).
 * Unauthenticated Accept: text/html is the inert wizard shell only — no credential read.
 * POST `/architect/bind-*` calls the same writers as CLI.
 * Field users cannot configure models, prompts, Temporal, tools, trust anchors, memory stores, or the machine.
 */
export class FieldHttpServer {
  private server?: http.Server;
  private readonly pending = new Map<string, PendingProgress>();
  private readonly subscriptionHold = new MemorySubscriptionAuthHold();
  private readonly connectorHold = new MemoryConnectorAuthHold();
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
        this.interceptGlmCallbackQuery(url);
        this.routeArchitectHabitat(req, res);
        return;
      }
      if (req.method === "GET" && path === "/architect/glm-callback") {
        this.routeArchitectGlmCallback(req, res, url);
        return;
      }
      if (req.method === "POST" && path === "/architect/bind-adapter") {
        await this.routeArchitectBindAdapter(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/set-adapter-credentials") {
        await this.routeArchitectSetAdapterCredentials(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/start-subscription-auth") {
        await this.routeArchitectStartSubscriptionAuth(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/complete-subscription-auth") {
        await this.routeArchitectCompleteSubscriptionAuth(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/edit-adapter-bind") {
        await this.routeArchitectEditAdapterBind(req, res);
        return;
      }
      if (req.method === "GET" && path === "/architect/adapter-bind") {
        this.routeArchitectReadAdapterBind(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/set-adapter-router") {
        await this.routeArchitectSetAdapterRouter(req, res);
        return;
      }
      if (req.method === "GET" && path === "/architect/adapter-router") {
        this.routeArchitectReadAdapterRouter(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/set-adapter-aggregator") {
        await this.routeArchitectSetAdapterAggregator(req, res);
        return;
      }
      if (req.method === "GET" && path === "/architect/adapter-aggregator") {
        this.routeArchitectReadAdapterAggregator(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/start-connector-auth") {
        await this.routeArchitectStartConnectorAuth(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/complete-connector-auth") {
        await this.routeArchitectCompleteConnectorAuth(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/bind-connector") {
        await this.routeArchitectBindConnector(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/edit-connector-bind") {
        await this.routeArchitectEditConnectorBind(req, res);
        return;
      }
      if (req.method === "GET" && path === "/architect/connector-bind") {
        this.routeArchitectReadConnectorBind(req, res);
        return;
      }
      if (req.method === "POST" && path === "/architect/set-connector-credentials") {
        await this.routeArchitectSetConnectorCredentials(req, res);
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
      assertFieldCannotSetNextWake(body as unknown as Record<string, unknown>);
      assertFieldCannotSetTrailerTtl(body as unknown as Record<string, unknown>);
      assertFieldCannotWriteBriefOrSteer(body as unknown as Record<string, unknown>);
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
      assertFieldCannotSetNextWake(body as unknown as Record<string, unknown>);
      assertFieldCannotSetTrailerTtl(body as unknown as Record<string, unknown>);
      assertFieldCannotWriteBriefOrSteer(body as unknown as Record<string, unknown>);
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
      assertFieldCannotSetTrailerTtl(body as unknown as Record<string, unknown>);
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
    core.grants.hydrateTenant(tenantId);
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
   * Listen on the declared host:port is the deploy; deploy.json is the ledger.
   */
  private async routeArchitectDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(req, res, "Field cannot deploy; Architect is the only deployer");
    if (!gate) return;
    const body = (await readJson(req)) as { host?: string; port?: number };
    const computerBaseDir = this.opts.core.fieldTokens.baseDir();
    if (!computerBaseDir) {
      throw new DeployIncompleteError("Hull computer is not started; deploy is incomplete");
    }
    const { record } = await architectDeploy({
      tenantId: this.opts.tenantId,
      computerBaseDir,
      core: this.opts.core,
      host: String(body.host ?? ""),
      port: Number(body.port),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, record);
  }

  /**
   * Architect message wake. Off `/field` and off the field HTML page.
   * Field token is 403 SURFACE_VIOLATION. Not sit().
   */
  private async routeArchitectMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(req, res, "Field cannot issue architect_message");
    if (!gate) return;
    const body = (await readJson(req)) as { body?: string; addresseeId?: string };
    const computerBaseDir = this.architectComputerDir();
    const woke = await architectDeliverMessage({
      tenantId: this.opts.tenantId,
      body: String(body.body ?? ""),
      addresseeId: typeof body.addresseeId === "string" ? body.addresseeId : undefined,
      computerBaseDir,
      habitat: this.opts.core.habitat,
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
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
   * Unauthenticated Accept: text/html is the inert wizard shell (no credential read).
   * Writes use the deploy-held Architect seat or a presented Architect credential.
   * Field token is 403 SURFACE_VIOLATION. Not a named desktop or IDE.
   */
  private routeArchitectHabitat(req: IncomingMessage, res: ServerResponse): void {
    if (wantsArchitectHabitatHtml(req.headers.accept) && !req.headers.authorization) {
      this.writeArchitectHabitatHtmlShell(res);
      return;
    }
    const gate = this.architectGate(req, res, "A field token cannot sit in the habitat");
    if (!gate) return;
    if (wantsArchitectHabitatHtml(req.headers.accept)) {
      this.writeArchitectHabitatHtmlShell(res);
      return;
    }
    const computerBaseDir = this.opts.core.fieldTokens.baseDir();
    if (!computerBaseDir) {
      this.json(res, 200, this.opts.core.architect.sit(this.opts.tenantId));
      return;
    }
    this.json(
      res,
      200,
      architectSit({
        tenantId: this.opts.tenantId,
        computerBaseDir,
        surface: this.opts.core.architect,
        architectToken: gate.presented,
        allowHeldSeat: gate.allowHeldSeat,
      }),
    );
  }

  /**
   * Architect adapter bind. Calls architectBindAdapter. Same file as CLI.
   * Field token is 403 SURFACE_VIOLATION. Not a /field route.
   */
  private async routeArchitectBindAdapter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { modelId?: string; vendorBaseUrl?: string };
    const bound = architectBindAdapter({
      tenantId: this.opts.tenantId,
      modelId: String(body.modelId ?? ""),
      vendorBaseUrl: typeof body.vendorBaseUrl === "string" ? body.vendorBaseUrl : undefined,
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, bound);
  }

  /**
   * Architect adapter credentials. Calls architectWriteAdapterCredentials.
   * Same file as CLI. Field token is 403 SURFACE_VIOLATION.
   */
  private async routeArchitectSetAdapterCredentials(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { apiKey?: string };
    const written = architectWriteAdapterCredentials({
      tenantId: this.opts.tenantId,
      apiKey: String(body.apiKey ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, { ok: true, tenantId: written.tenantId, writtenBy: written.writtenBy });
  }

  /**
   * Guided subscription sign-in start. Wizard holds the in-flight session.
   * Complete writes through architectBindAdapter + architectWriteAdapterCredentials.
   */
  private async routeArchitectStartSubscriptionAuth(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { providerId?: string };
    const started = await architectStartSubscriptionAuth({
      tenantId: this.opts.tenantId,
      providerId: String(body.providerId ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
      hold: this.subscriptionHold,
    });
    this.json(res, 201, started);
  }

  /**
   * Poll/complete guided subscription sign-in. Binds through the existing writers.
   * Never returns the vendor session secret.
   */
  private async routeArchitectCompleteSubscriptionAuth(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as {
      authId?: string;
      code?: string;
      authCode?: string;
      state?: string;
    };
    const result = await architectCompleteSubscriptionAuth({
      tenantId: this.opts.tenantId,
      authId: String(body.authId ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
      hold: this.subscriptionHold,
      code: body.code,
      authCode: body.authCode,
      state: body.state,
    });
    this.json(res, result.status === "bound" ? 201 : 200, result);
  }

  /**
   * Admin edit of an already-bound adapter. Same writer as bind-adapter.
   * Unbound modelId is ADAPTER_NOT_BOUND — add stays on the wizard.
   */
  private async routeArchitectEditAdapterBind(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { modelId?: string; vendorBaseUrl?: string };
    const bound = architectEditAdapterBind({
      tenantId: this.opts.tenantId,
      modelId: String(body.modelId ?? ""),
      vendorBaseUrl: typeof body.vendorBaseUrl === "string" ? body.vendorBaseUrl : undefined,
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, bound);
  }

  /** Architect-gated read of adapter-bind.json. Never returns credentials. */
  private routeArchitectReadAdapterBind(req: IncomingMessage, res: ServerResponse): void {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const store = readTenantAdapterBinds(this.architectComputerDir(), this.opts.tenantId);
    this.json(res, 200, {
      models: store.models.map((row) => ({
        tenantId: row.tenantId,
        modelId: row.modelId,
        boundBy: row.boundBy,
        boundAt: row.boundAt,
        ...(row.vendorBaseUrl ? { vendorBaseUrl: row.vendorBaseUrl } : {}),
      })),
    });
  }

  /**
   * Architect router write. Calls architectWriteAdapterRouter.
   * Field token is 403 SURFACE_VIOLATION.
   */
  private async routeArchitectSetAdapterRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { rules?: string };
    const written = architectWriteAdapterRouter({
      tenantId: this.opts.tenantId,
      rules: String(body.rules ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, { ok: true, tenantId: written.tenantId, boundBy: written.boundBy, rules: written.rules });
  }

  private routeArchitectReadAdapterRouter(req: IncomingMessage, res: ServerResponse): void {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const record = readTenantAdapterRouter(this.architectComputerDir(), this.opts.tenantId);
    this.json(res, 200, record ? { rules: record.rules, boundBy: record.boundBy } : { rules: "" });
  }

  /**
   * Architect aggregator write. Calls architectWriteAdapterAggregator.
   * Field token is 403 SURFACE_VIOLATION.
   */
  private async routeArchitectSetAdapterAggregator(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { combine?: string };
    const written = architectWriteAdapterAggregator({
      tenantId: this.opts.tenantId,
      combine: String(body.combine ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, {
      ok: true,
      tenantId: written.tenantId,
      boundBy: written.boundBy,
      combine: written.combine,
    });
  }

  private routeArchitectReadAdapterAggregator(req: IncomingMessage, res: ServerResponse): void {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const record = readTenantAdapterAggregator(this.architectComputerDir(), this.opts.tenantId);
    this.json(res, 200, record ? { combine: record.combine, boundBy: record.boundBy } : { combine: "" });
  }

  /**
   * Official named-connector login start. Wizard holds the in-flight session.
   * Complete writes through architectBindConnector + architectWriteConnectorCredentials.
   */
  private async routeArchitectStartConnectorAuth(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { connectorId?: string; clientId?: string };
    const started = await architectStartConnectorAuth({
      tenantId: this.opts.tenantId,
      connectorId: String(body.connectorId ?? ""),
      clientId: typeof body.clientId === "string" ? body.clientId : undefined,
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
      hold: this.connectorHold,
    });
    this.json(res, 201, started);
  }

  /**
   * Poll/complete official named-connector login. Binds through the existing writers.
   * Never returns the vendor session secret.
   */
  private async routeArchitectCompleteConnectorAuth(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { authId?: string };
    const result = await architectCompleteConnectorAuth({
      tenantId: this.opts.tenantId,
      authId: String(body.authId ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
      hold: this.connectorHold,
    });
    this.json(res, result.status === "bound" ? 201 : 200, result);
  }

  /**
   * Architect connector bind. Calls architectBindConnector. Same file as CLI.
   * Field token is 403 SURFACE_VIOLATION. Not a /field route.
   */
  private async routeArchitectBindConnector(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as {
      connectorId?: string;
      baseUrl?: string;
      requiresCredentials?: boolean;
    };
    const bound = architectBindConnector({
      tenantId: this.opts.tenantId,
      connectorId: String(body.connectorId ?? ""),
      requiresCredentials: body.requiresCredentials === true,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, {
      ok: true,
      tenantId: bound.tenantId,
      connectorId: bound.connectorId,
      boundBy: bound.boundBy,
      ...(bound.baseUrl ? { baseUrl: bound.baseUrl } : {}),
    });
  }

  /**
   * Admin edit of an already-bound connector. Same writer as bind-connector.
   * Unbound connectorId is CONNECTOR_UNBOUND — add stays on the wizard.
   */
  private async routeArchitectEditConnectorBind(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as {
      connectorId?: string;
      baseUrl?: string;
      requiresCredentials?: boolean;
    };
    const bound = architectEditConnectorBind({
      tenantId: this.opts.tenantId,
      connectorId: String(body.connectorId ?? ""),
      requiresCredentials: body.requiresCredentials === true,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, {
      ok: true,
      tenantId: bound.tenantId,
      connectorId: bound.connectorId,
      boundBy: bound.boundBy,
      ...(bound.baseUrl ? { baseUrl: bound.baseUrl } : {}),
    });
  }

  /** Architect-gated read of connector-bind.json. Never returns secrets. */
  private routeArchitectReadConnectorBind(req: IncomingMessage, res: ServerResponse): void {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const store = readTenantConnectorBinds(this.architectComputerDir(), this.opts.tenantId);
    this.json(res, 200, {
      connectors: store.connectors.map((row) => ({
        tenantId: row.tenantId,
        connectorId: row.connectorId,
        boundBy: row.boundBy,
        boundAt: row.boundAt,
        requiresCredentials: row.requiresCredentials,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      })),
    });
  }

  /**
   * Architect connector credentials. Calls architectWriteConnectorCredentials.
   * Same file as CLI. Field token is 403 SURFACE_VIOLATION.
   */
  private async routeArchitectSetConnectorCredentials(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const gate = this.architectGate(
      req,
      res,
      "A field token cannot bind, see, or edit the adapter or connectors",
    );
    if (!gate) return;
    const body = (await readJson(req)) as { connectorId?: string; secret?: string };
    const written = architectWriteConnectorCredentials({
      tenantId: this.opts.tenantId,
      connectorId: String(body.connectorId ?? ""),
      secret: String(body.secret ?? ""),
      computerBaseDir: this.architectComputerDir(),
      architectToken: gate.presented,
      allowHeldSeat: gate.allowHeldSeat,
    });
    this.json(res, 201, {
      ok: true,
      tenantId: written.tenantId,
      connectorId: written.connectorId,
      writtenBy: written.writtenBy,
    });
  }

  /**
   * Official Continue with Z.ai hop / zcode:// intercept. Mailboxes code+state.
   * Never returns the session. Field is 403.
   */
  private routeArchitectGlmCallback(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const gate = this.architectGate(req, res, "A field token cannot sit in the habitat");
    if (!gate) return;
    const parsed = parseGlmAuthorizationCallback(url.toString());
    if (!parsed) {
      this.json(res, 400, { error: "SUBSCRIPTION_AUTH_REQUIRED", message: "ZCode official login must return state and code" });
      return;
    }
    receiveGlmAuthorizationCode(parsed.state, parsed.code);
    if (wantsArchitectHabitatHtml(req.headers.accept)) {
      this.write(res, 200, "<!DOCTYPE html><html><body><p>Continue with Z.ai received.</p></body></html>", {
        "content-type": "text/html; charset=utf-8",
        ...CORS,
      });
      return;
    }
    this.json(res, 200, { status: "received" });
  }

  private interceptGlmCallbackQuery(url: URL): void {
    const parsed = parseGlmAuthorizationCallback(url.toString());
    if (parsed) receiveGlmAuthorizationCode(parsed.state, parsed.code);
  }

  /** Static inert wizard shell. Does not read, mint, or write any credential. */
  private writeArchitectHabitatHtmlShell(res: ServerResponse): void {
    this.write(res, 200, architectHabitatPageHtml(), {
      "content-type": "text/html; charset=utf-8",
      ...CORS,
    });
  }

  /**
   * Architect HTTP gate. Field is 403. Missing bearer uses the deploy-held
   * Architect seat on the tenant computer. Presented Architect credential still works.
   * HTTP never returns the session secret.
   */
  private architectGate(
    req: IncomingMessage,
    res: ServerResponse,
    fieldMessage: string,
  ): { presented?: string; allowHeldSeat: boolean } | undefined {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (!token) {
        this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
        return undefined;
      }
      const principal = this.opts.core.fieldTokens.lookup(token, this.opts.tenantId);
      if (principal === "field") {
        this.json(res, 403, { error: "SURFACE_VIOLATION", message: fieldMessage });
        return undefined;
      }
      if (principal !== "architect") {
        this.json(res, 401, { error: "UNAUTHORIZED", message: "Unknown or revoked Architect credential" });
        return undefined;
      }
      return { presented: token, allowHeldSeat: false };
    }
    const computerBaseDir = this.opts.core.fieldTokens.baseDir();
    if (computerBaseDir && this.opts.core.fieldTokens.hasActiveArchitect(this.opts.tenantId)) {
      return { allowHeldSeat: true };
    }
    this.json(res, 401, { error: "UNAUTHORIZED", message: "Architect credential required" });
    return undefined;
  }

  private architectComputerDir(): string {
    const computerBaseDir = this.opts.core.fieldTokens.baseDir();
    if (!computerBaseDir) {
      throw new AvError("ARCHITECT_SEAT_UNBOUND", "Architect seat requires a live habitat");
    }
    return computerBaseDir;
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
                err.code === "GRANT_STORE_CORRUPT" ||
                err.code === "TOKEN_STORE_CORRUPT" ||
                err.code === "FACT_STORE_CORRUPT" ||
                err.code === "RECORD_STORE_CORRUPT" ||
                err.code === "RUN_STORE_CORRUPT" ||
                err.code === "WORKER_STORE_CORRUPT" ||
                err.code === "MEMORY_STORE_CORRUPT" ||
                err.code === "ADAPTER_BIND_CORRUPT" ||
                err.code === "ADAPTER_CREDENTIALS_CORRUPT" ||
                err.code === "ADAPTER_ROUTER_CORRUPT" ||
                err.code === "ADAPTER_AGGREGATOR_CORRUPT" ||
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
  assertFieldCannotSetNextWake(body);
  assertFieldCannotSetTrailerTtl(body);
  assertFieldCannotWriteBriefOrSteer(body);
  const named = new Set(["agentId", "agent", "workerType", "assigneeAgentId", "assignee", "who"]);
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    const selector = named.has(key) || (lower.includes("pick") && lower.includes("agent"));
    if (selector && value !== undefined && value !== null && String(value).trim() !== "") {
      throw new AvError("FIELD_CANNOT_PICK_AGENT", "Continue is a wake; field SHALL NOT pick who works");
    }
  }
}

/** Field SHALL NOT set run.nextWake, assumptions, or risks. Kernel-owned typed decision. */
function assertFieldCannotSetNextWake(body: Record<string, unknown>): void {
  if (body.nextWake !== undefined) {
    throw new SurfaceViolationError("Field SHALL NOT set nextWake");
  }
  if (body.assumptions !== undefined) {
    throw new SurfaceViolationError("Field SHALL NOT set assumptions");
  }
  if (body.risks !== undefined) {
    throw new SurfaceViolationError("Field SHALL NOT set risks");
  }
}

/** Field SHALL NOT set or extend trailer TTL. Kernel stamps coder expiresAt. */
function assertFieldCannotSetTrailerTtl(body: Record<string, unknown>): void {
  if (
    body.trailerTtl !== undefined ||
    body.expiresAt !== undefined ||
    body.ttl !== undefined ||
    body.trailerExpiresAt !== undefined
  ) {
    throw new SurfaceViolationError("Field SHALL NOT set trailer TTL");
  }
}

/** Field SHALL NOT write a brief, steer a worker, or report. Talking issues those verbs. */
function assertFieldCannotWriteBriefOrSteer(body: Record<string, unknown>): void {
  if (body.brief !== undefined || body.steer !== undefined || body.report !== undefined) {
    throw new SurfaceViolationError("Field SHALL NOT write a brief, steer a worker, or report");
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
