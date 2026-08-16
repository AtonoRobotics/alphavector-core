import type { AdapterCredentials, AdapterInput, CognitiveIntent } from "./types.js";

/**
 * Vendor-shaped think hop. Not the CI intent mapper. Not the SDK loop.
 * Credentials authorize the call; they are not copied into the returned intent
 * and are not model context.
 *
 * This slice uses a recorded vendor fixture (VCR-shaped completion). A live
 * hosted-model HTTP call is leftover.
 */
export interface VendorThinkClient {
  readonly name: string;
  complete(input: AdapterInput, credentials: AdapterCredentials): CognitiveIntent;
}

/** Recorded vendor completions. Not the CI intent mapper. */
const RECORDED_VENDOR_COMPLETIONS = {
  talkingAsk: { pass: "talking", act: "follow_up" },
  talkingStart: { pass: "talking", act: "launch_worker", workerType: "coder" },
  worker: {
    pass: "worker",
    act: "propose_effect",
    actionClass: "communicate",
    channel: "email",
    purpose: "follow-up",
  },
} as const;

export const recordedVendorClient: VendorThinkClient = {
  name: "recorded-vendor",
  complete(input, credentials) {
    return replayRecordedVendor(input, credentials);
  },
};

export function vendorThink(
  input: AdapterInput,
  credentials: AdapterCredentials,
  client: VendorThinkClient = recordedVendorClient,
): CognitiveIntent {
  return client.complete(input, credentials);
}

/**
 * Vendor-shaped recorded call. Requires credentials to authorize.
 * Returns a canned vendor completion parsed into CognitiveIntent.
 */
export function replayRecordedVendor(
  input: AdapterInput,
  credentials: AdapterCredentials,
): CognitiveIntent {
  if (!credentials.apiKey.trim()) {
    throw new Error("recorded vendor requires credentials");
  }
  if (input.pass === "talking") {
    if (input.event.kind === "field_ask" || input.event.kind === "mail" || input.event.kind === "deadline") {
      return { ...RECORDED_VENDOR_COMPLETIONS.talkingAsk };
    }
    return { ...RECORDED_VENDOR_COMPLETIONS.talkingStart };
  }
  return {
    ...RECORDED_VENDOR_COMPLETIONS.worker,
    subject: input.run.recordId ?? input.event.recordId ?? "unspecified",
  };
}
