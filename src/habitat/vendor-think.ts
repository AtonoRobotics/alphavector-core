import { AvError } from "../errors.js";
import type { AdapterCredentials, AdapterInput, CognitiveIntent, LabeledMemory } from "./types.js";

/**
 * Vendor-shaped think hop. Not the CI intent mapper. Not the SDK loop.
 * Credentials authorize the HTTP call; they are not copied into the body
 * or the returned intent and are not model context.
 *
 * Product path is live HTTP to the hosted model using the OpenAI-compatible
 * chat-completions request/response. The host is never hardcoded. Product
 * reads the Architect-written bind on tenant disk. AV_VENDOR_BASE_URL and
 * injected vendorBaseUrl are CI/fixture fallbacks when the bind has no URL.
 */
export interface VendorThinkClient {
  readonly name: string;
  complete(input: AdapterInput, credentials: AdapterCredentials): Promise<CognitiveIntent>;
}

/** Handles only. Never the Architect-written secret. Carried in messages. */
export interface VendorThinkHandles {
  pass: AdapterInput["pass"];
  kind: AdapterInput["event"]["kind"];
  runId: string;
  recordId?: string;
  /** Loaded skill bodies. Omitted when the store is empty. */
  skills?: Array<{ name: string; description: string; body: string }>;
  /**
   * Durable labeled memory the think pass actually receives (HK-072).
   * Always present. Empty store is empty labeled memory, not omitted.
   * A missing field means the wake thought without inject.
   */
  memory: LabeledMemory;
}

/** OpenAI-compatible chat-completions body. Secret is never in this object. */
export interface VendorThinkRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export const VENDOR_THINK_PATH = "/v1/chat/completions";
export const VENDOR_BASE_URL_ENV = "AV_VENDOR_BASE_URL";

const INTENT_SYSTEM =
  "Return only a JSON object with keys pass, act, and optional workerType, actionClass, channel, purpose, subject.";

export function vendorThinkHandles(input: AdapterInput): VendorThinkHandles {
  const skills = input.skills
    .filter((skill) => skill.body.trim().length > 0)
    .map((skill) => ({ name: skill.name, description: skill.description, body: skill.body }));
  return {
    pass: input.pass,
    kind: input.event.kind,
    runId: input.run.runId,
    ...(input.run.recordId ?? input.event.recordId
      ? { recordId: input.run.recordId ?? input.event.recordId }
      : {}),
    ...(skills.length ? { skills } : {}),
    memory: input.memory,
  };
}

export function vendorThinkBody(input: AdapterInput): VendorThinkRequest {
  return {
    model: input.bind?.modelId?.trim() ?? "",
    messages: [
      { role: "system", content: INTENT_SYSTEM },
      { role: "user", content: JSON.stringify(vendorThinkHandles(input)) },
    ],
  };
}

export function hostedVendorClient(baseUrl?: string): VendorThinkClient {
  return {
    name: "hosted-vendor",
    complete(input, credentials) {
      return hostedVendorComplete(input, credentials, baseUrl);
    },
  };
}

export async function vendorThink(
  input: AdapterInput,
  credentials: AdapterCredentials,
  client: VendorThinkClient = hostedVendorClient(),
): Promise<CognitiveIntent> {
  return client.complete(input, credentials);
}

async function hostedVendorComplete(
  input: AdapterInput,
  credentials: AdapterCredentials,
  baseUrl?: string,
): Promise<CognitiveIntent> {
  const apiKey = credentials.apiKey.trim();
  if (!apiKey) {
    throw new AvError(
      "ADAPTER_CREDENTIALS_MISSING",
      "Architect must write provider credentials before think; no CI mapper default",
    );
  }
  const url = thinkUrl(resolveVendorBaseUrl(baseUrl, input.bind?.vendorBaseUrl));
  const body = vendorThinkBody(input);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AvError("ADAPTER_VENDOR_UNREACHABLE", "Hosted model HTTP call failed closed");
  }
  if (res.status === 401 || res.status === 403) {
    throw new AvError(
      "ADAPTER_CREDENTIALS_REJECTED",
      "Provider rejected the Architect-written credentials",
    );
  }
  if (!res.ok) {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model rejected the think hop");
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  return parseVendorIntent(raw);
}

export function resolveVendorBaseUrl(explicit?: string, bindUrl?: string): string {
  const raw = (bindUrl ?? explicit ?? process.env[VENDOR_BASE_URL_ENV] ?? "").trim();
  if (!raw) {
    throw new AvError(
      "ADAPTER_VENDOR_URL_MISSING",
      "Hosted model URL is not configured; refusing to invent an endpoint",
    );
  }
  return raw.replace(/\/+$/, "");
}

function thinkUrl(baseUrl: string): string {
  return `${baseUrl}${VENDOR_THINK_PATH}`;
}

function parseVendorIntent(raw: unknown): CognitiveIntent {
  const content = extractChatContent(raw);
  const parsed = parseContent(content);
  return asCognitiveIntent(parsed);
}

function extractChatContent(raw: unknown): unknown {
  if (!isRecord(raw)) {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  const first = choices[0];
  if (isRecord(first.message)) {
    return first.message.content;
  }
  if (typeof first.text === "string") {
    return first.text;
  }
  throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
}

function parseContent(content: unknown): unknown {
  if (isRecord(content)) return content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
}

function asCognitiveIntent(raw: unknown): CognitiveIntent {
  if (!isRecord(raw)) {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  if (raw.pass !== "talking" && raw.pass !== "worker") {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  if (
    raw.act !== "launch_worker" &&
    raw.act !== "propose_effect" &&
    raw.act !== "done" &&
    raw.act !== "follow_up"
  ) {
    throw new AvError("ADAPTER_VENDOR_REJECTED", "Hosted model returned an unusable think body");
  }
  const intent: CognitiveIntent = { pass: raw.pass, act: raw.act };
  if (raw.workerType === "coder") intent.workerType = "coder";
  if (typeof raw.actionClass === "string") intent.actionClass = raw.actionClass;
  if (typeof raw.channel === "string") intent.channel = raw.channel;
  if (typeof raw.purpose === "string") intent.purpose = raw.purpose;
  if (typeof raw.subject === "string") intent.subject = raw.subject;
  return intent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
