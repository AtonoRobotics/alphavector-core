import { nowIso } from "../ids.js";
import { AvError } from "../errors.js";
import {
  adapterCredentialsFile,
  saveAdapterCredentials,
  type AdapterCredentialsRecord,
} from "../habitat/adapter-credentials.js";
import { requireArchitect } from "./require-architect.js";

/**
 * Architect writes tenants/{id}/adapter-credentials.json.
 * Same write gate as adapter-bind and field-tokens. Shell is not Architect.
 * Field SHALL NOT set, see, or edit. Not a /field route. Not on adapter-bind.json.
 */
export function architectWriteAdapterCredentials(input: {
  tenantId: string;
  apiKey: string;
  refreshToken?: string;
  computerBaseDir: string;
  architectToken?: string;
}): AdapterCredentialsRecord {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new AvError("ADAPTER_CREDENTIALS_REQUIRED", "Architect credentials write requires an api key");
  }
  requireArchitect(input.tenantId, input.computerBaseDir, input.architectToken);
  const refreshToken = input.refreshToken?.trim();
  const record: AdapterCredentialsRecord = {
    tenantId: input.tenantId,
    apiKey,
    ...(refreshToken ? { refreshToken } : {}),
    writtenBy: "architect",
    writtenAt: nowIso(),
  };
  saveAdapterCredentials(adapterCredentialsFile(input.computerBaseDir, input.tenantId), record);
  return record;
}
