import http from "node:http";
import type { AddressInfo } from "node:net";
import { architectBindConnector, architectWriteConnectorCredentials } from "../src/auth/architect-connectors.js";
import { RECORDED_EMAIL_SEND, type ConnectorSend } from "../src/habitat/connector-world.js";
import type { LoadedPack } from "../src/packs/types.js";

export const WORLD_FIXTURE_SECRET = "av-world-fixture-secret";
export { RECORDED_EMAIL_SEND };
export const WORLD_FIXTURE_SEND: ConnectorSend = RECORDED_EMAIL_SEND;
export const WORLD_FIXTURE_SMS_SEND: ConnectorSend = {
  to: "+15555550100",
  from: "+15555550199",
  body: "follow-up",
};

export type WorldHttpCapture = {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
};

const doubles: Array<{ close: () => Promise<void> }> = [];
let current: { url: string; requests: WorldHttpCapture[]; close: () => Promise<void> } | undefined;

/** Local HTTP double. Product world call must fetch this. No vendor key. */
export async function startWorldDouble(opts?: {
  secret?: string;
  rejectAuth?: boolean;
  status?: number;
}): Promise<{ url: string; requests: WorldHttpCapture[]; close: () => Promise<void> }> {
  const requests: WorldHttpCapture[] = [];
  const expectedKey = opts?.secret ?? WORLD_FIXTURE_SECRET;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        body,
      });
      if (req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!isRecordedSend(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_a_send" }));
        return;
      }
      if (opts?.rejectAuth || req.headers.authorization !== `Bearer ${expectedKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const status = opts?.status ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  const started = { url: `http://127.0.0.1:${addr.port}`, requests, close };
  doubles.push(started);
  return started;
}

export async function useWorldHttp(opts?: {
  secret?: string;
  rejectAuth?: boolean;
  status?: number;
}): Promise<{ url: string; requests: WorldHttpCapture[]; close: () => Promise<void> }> {
  if (!current || opts) {
    current = await startWorldDouble(opts);
  }
  return current;
}

export async function closeWorldHttp(): Promise<void> {
  current = undefined;
  while (doubles.length) {
    await doubles.pop()?.close();
  }
}

export function bindWorldConnector(input: {
  tenantId: string;
  computerBaseDir: string;
  architectToken: string;
  baseUrl: string;
  connectorId: string;
  secret?: string;
  requiresCredentials?: boolean;
}): void {
  architectBindConnector({
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    computerBaseDir: input.computerBaseDir,
    architectToken: input.architectToken,
    baseUrl: input.baseUrl,
    requiresCredentials: input.requiresCredentials !== false,
  });
  if (input.requiresCredentials !== false) {
    architectWriteConnectorCredentials({
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      secret: input.secret ?? WORLD_FIXTURE_SECRET,
      computerBaseDir: input.computerBaseDir,
      architectToken: input.architectToken,
    });
  }
}

export function bindWorldForPack(input: {
  tenantId: string;
  computerBaseDir: string;
  architectToken: string;
  pack: LoadedPack;
  baseUrl: string;
  secret?: string;
  requiresCredentials?: boolean;
}): string {
  const connectorId = input.pack.binding.connectors[0]?.id;
  if (!connectorId) throw new Error("loaded pack has no connectors");
  bindWorldConnector({ ...input, connectorId });
  return connectorId;
}

export function isRecordedSend(body: unknown): body is ConnectorSend & { channel?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  return (
    typeof rec.to === "string" &&
    rec.to.trim() !== "" &&
    typeof rec.body === "string" &&
    rec.body.trim() !== "" &&
    typeof rec.from === "string" &&
    rec.from.trim() !== ""
  );
}

/** Assert the recorded adapter saw a send, not a handle ping. */
export function recordedSendOf(body: unknown): ConnectorSend & { channel?: string } {
  if (!isRecordedSend(body)) {
    throw new Error("world double did not receive a send payload");
  }
  const rec = body as ConnectorSend & { channel?: string; handleId?: string };
  if (rec.handleId) {
    throw new Error("world double received a handle ping, not a send");
  }
  return rec;
}
