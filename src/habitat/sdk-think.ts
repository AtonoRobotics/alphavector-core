import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { AvError } from "../errors.js";
import { serializeSkillMarkdown } from "./skills.js";
import type { AdapterCredentials, AdapterInput, CognitiveIntent, LabeledMemory } from "./types.js";
import {
  cognitiveIntentFromUnknown,
  vendorThink,
  vendorThinkHandles,
  type VendorThinkClient,
} from "./vendor-think.js";

/**
 * Inputs the Deep Agents SDK pass actually receives (DEC-003).
 * Skill bodies and labeled memory are contents, not only paths.
 * The official SDK skills/memory params are path-based; contents go in
 * systemPrompt, invoke files, and the user handles.
 */
export interface DeepAgentsSdkPass {
  modelId: string;
  systemPrompt: string;
  userContent: string;
  skills: Array<{ name: string; description: string; body: string }>;
  skillSources: string[];
  memory: LabeledMemory;
  files: Record<string, { content: string[]; created_at: string; modified_at: string }>;
}

/**
 * Vendor-bound chat model for the SDK pass. Host comes from Architect bind
 * (or the CI AV_VENDOR_BASE_URL override). No public vendor host in source.
 * Does not call wake, run, worker, admit, persist, or sleep.
 */
export class VendorBoundChatModel extends BaseChatModel {
  constructor(
    private readonly hop: {
      input: AdapterInput;
      credentials: AdapterCredentials;
      vendor: VendorThinkClient;
    },
  ) {
    super({});
  }

  _llmType(): string {
    return "av-vendor-think";
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const intent = await vendorThink(this.hop.input, this.hop.credentials, this.hop.vendor);
    const text = JSON.stringify(intent);
    return { generations: [{ text, message: new AIMessage(text) }] };
  }

  override bindTools(_tools: unknown[]): this {
    return this;
  }
}

export function sdkThinkPassFromInput(input: AdapterInput): DeepAgentsSdkPass {
  const handles = vendorThinkHandles(input);
  const skills = handles.skills ?? [];
  const now = new Date().toISOString();
  const files: DeepAgentsSdkPass["files"] = {};
  for (const skill of skills) {
    files[`/skills/${skill.name}/SKILL.md`] = {
      content: serializeSkillMarkdown(skill).replace(/\n$/, "").split("\n"),
      created_at: now,
      modified_at: now,
    };
  }
  return {
    modelId: input.bind?.modelId?.trim() ?? "",
    systemPrompt: [
      "Return only a JSON object with keys pass, act, and optional workerType, actionClass, channel, purpose, subject, nextWake, brief, body.",
      "This pass receives Architect-loaded skill bodies and labeled memory.",
      "It does not own wake, run, worker, admit, persist, or sleep.",
      JSON.stringify({ skills, memory: handles.memory }),
    ].join("\n"),
    userContent: JSON.stringify(handles),
    skills,
    skillSources: skills.map((skill) => `/skills/${skill.name}/`),
    memory: handles.memory,
    files,
  };
}

export function intentFromSdkResult(result: unknown): CognitiveIntent {
  if (isRecord(result) && "structuredResponse" in result) {
    try {
      return cognitiveIntentFromUnknown(result.structuredResponse);
    } catch {
      // Fall through to messages.
    }
  }
  const messages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messageContent(messages[i]);
    if (typeof content !== "string" || !content.trim()) continue;
    try {
      return cognitiveIntentFromUnknown(JSON.parse(content));
    } catch {
      try {
        return cognitiveIntentFromUnknown(content);
      } catch {
        // Keep scanning earlier messages.
      }
    }
  }
  throw new AvError("ADAPTER_VENDOR_REJECTED", "Deep Agents SDK pass returned an unusable think body");
}

function messageContent(message: unknown): unknown {
  if (!isRecord(message)) return undefined;
  return message.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
