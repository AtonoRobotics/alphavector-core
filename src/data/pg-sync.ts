import { createRequire } from "node:module";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { AvError } from "../errors.js";

export interface LedgerQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

interface WorkerOk {
  ok: true;
  result: LedgerQueryResult | { connected: true };
}

interface WorkerErr {
  ok: false;
  error: string;
}

type WorkerReply = WorkerOk | WorkerErr;

const require = createRequire(import.meta.url);
const PG_PATH = require.resolve("pg");

const workerSource = `
const { parentPort } = require("node:worker_threads");
const { Client, types } = require(${JSON.stringify(PG_PATH)});

types.setTypeParser(1184, (value) => new Date(value).toISOString());
types.setTypeParser(1114, (value) => new Date(value).toISOString());

let client;

function quoteIdent(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("Durable store schema name is invalid");
  }
  return '"' + name + '"';
}

async function withSchema(schema, fn) {
  if (schema !== "public") {
    await client.query("CREATE SCHEMA IF NOT EXISTS " + quoteIdent(schema));
  }
  await client.query("SET search_path TO " + quoteIdent(schema));
  return fn();
}

parentPort.on("message", async (msg) => {
  const { lock, port } = msg;
  try {
    if (msg.type === "connect") {
      if (!client) {
        client = new Client({ connectionString: msg.url });
        await client.connect();
      }
      port.postMessage({ ok: true, result: { connected: true } });
    } else if (msg.type === "query") {
      const result = await withSchema(msg.schema, () => client.query(msg.sql, msg.params ?? []));
      port.postMessage({
        ok: true,
        result: { rows: result.rows, rowCount: result.rowCount ?? result.rows.length },
      });
    } else if (msg.type === "apply") {
      await withSchema(msg.schema, async () => {
        for (const sql of msg.statements) {
          if (typeof sql === "string" && sql.trim()) await client.query(sql);
        }
      });
      port.postMessage({ ok: true, result: { rows: [], rowCount: 0 } });
    } else {
      throw new Error("Unknown ledger worker message");
    }
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    Atomics.store(lock, 0, 1);
    Atomics.notify(lock, 0);
    port.close();
  }
});
`;

let worker: Worker | undefined;
let connectedUrl: string | undefined;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(workerSource, { eval: true });
  worker.on("error", () => {
    worker = undefined;
    connectedUrl = undefined;
  });
  worker.unref();
  return worker;
}

function callWorker(message: Record<string, unknown>): WorkerReply {
  const { port1, port2 } = new MessageChannel();
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(lock, 0, 0);
  ensureWorker().postMessage({ ...message, lock, port: port2 }, [port2]);
  const wait = Atomics.wait(lock, 0, 0, 60_000);
  if (wait === "timed-out") {
    port1.close();
    throw new AvError("LEDGER_TIMEOUT", "PostgreSQL query timed out");
  }
  const received = receiveMessageOnPort(port1);
  port1.close();
  if (!received) {
    throw new AvError("LEDGER_UNREACHABLE", "PostgreSQL worker returned no result");
  }
  return received.message as WorkerReply;
}

function unwrap(reply: WorkerReply, closedMessage: string): LedgerQueryResult | { connected: true } {
  if (!reply.ok) {
    throw new AvError("LEDGER_UNREACHABLE", `${closedMessage}: ${reply.error}`);
  }
  return reply.result;
}

export function connectLedger(url: string): void {
  if (connectedUrl && connectedUrl !== url) {
    throw new AvError(
      "LEDGER_URL_LOCKED",
      "This process is already bound to a DATABASE_URL; refusing to open a second ledger",
    );
  }
  unwrap(callWorker({ type: "connect", url }), "PostgreSQL is unreachable");
  connectedUrl = url;
}

export function applyLedgerSql(schema: string, statements: string[]): void {
  unwrap(callWorker({ type: "apply", schema, statements }), "PostgreSQL schema apply failed");
}

export function ledgerQuery(
  schema: string,
  sql: string,
  params: unknown[] = [],
): LedgerQueryResult {
  const result = unwrap(callWorker({ type: "query", schema, sql, params }), "PostgreSQL query failed");
  if ("connected" in result) {
    throw new AvError("LEDGER_UNREACHABLE", "PostgreSQL worker returned a connect result for a query");
  }
  return result;
}
