export type AttachMode = "subscription" | "api";
export type FieldNeed = "required" | "optional" | "hidden" | "guided";

export type WizardStepId =
  | "session"
  | "attach-model"
  | "attach-connector"
  | "router"
  | "aggregator"
  | "confirm";

export interface ProviderFields {
  subscriptionAuth: FieldNeed;
  startUrl: FieldNeed;
  apiKey: FieldNeed;
  vendorBaseUrl: FieldNeed;
  modelId: FieldNeed;
}

export type ConnectorAttachKind = "oauth" | "generic-mcp";

export interface ConnectorChoice {
  id: string;
  label: string;
  kind: ConnectorAttachKind;
  /** Written as connector-bind connectorId when the Architect does not type one. */
  bindConnectorId?: string;
}

export interface ProviderChoice {
  id: string;
  label: string;
  mode: AttachMode;
  /** Written as adapter-bind modelId when the Architect does not type one. */
  bindModelId?: string;
  fields: ProviderFields;
}

export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStepId; title: string; path: "add" }> = [
  { id: "session", title: "Architect session", path: "add" },
  { id: "attach-model", title: "Attach model", path: "add" },
  { id: "attach-connector", title: "Attach connector", path: "add" },
  { id: "router", title: "Model router", path: "add" },
  { id: "aggregator", title: "Multi-model aggregator", path: "add" },
  { id: "confirm", title: "Confirm", path: "add" },
];

export const HABITAT_PROVIDERS: readonly ProviderChoice[] = [
  {
    id: "sub-codex",
    label: "Codex Subscription",
    mode: "subscription",
    bindModelId: "codex-subscription",
    fields: {
      subscriptionAuth: "guided",
      startUrl: "hidden",
      apiKey: "hidden",
      vendorBaseUrl: "hidden",
      modelId: "hidden",
    },
  },
  {
    id: "sub-grok",
    label: "Grok Subscription",
    mode: "subscription",
    bindModelId: "grok-subscription",
    fields: {
      subscriptionAuth: "guided",
      startUrl: "hidden",
      apiKey: "hidden",
      vendorBaseUrl: "hidden",
      modelId: "hidden",
    },
  },
  {
    id: "sub-glm",
    label: "GLM subscription",
    mode: "subscription",
    bindModelId: "glm-subscription",
    fields: {
      subscriptionAuth: "guided",
      startUrl: "hidden",
      apiKey: "hidden",
      vendorBaseUrl: "hidden",
      modelId: "hidden",
    },
  },
  {
    id: "api-claude",
    label: "Claude",
    mode: "api",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "optional",
      modelId: "required",
    },
  },
  {
    id: "api-codex",
    label: "Codex",
    mode: "api",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "optional",
      modelId: "required",
    },
  },
  {
    id: "api-grok",
    label: "Grok",
    mode: "api",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "optional",
      modelId: "required",
    },
  },
  {
    id: "api-kimi",
    label: "Kimi",
    mode: "api",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "optional",
      modelId: "required",
    },
  },
  {
    id: "api-glm",
    label: "GLM",
    mode: "api",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "optional",
      modelId: "required",
    },
  },
  {
    id: "api-generic-openai",
    label: "Generic OpenAI (vLLM / Ollama)",
    mode: "api",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "optional",
      vendorBaseUrl: "required",
      modelId: "required",
    },
  },
];

export const HABITAT_CONNECTORS: readonly ConnectorChoice[] = [
  {
    id: "conn-github",
    label: "GitHub",
    kind: "oauth",
    bindConnectorId: "github",
  },
  {
    id: "conn-generic-mcp",
    label: "Generic / private MCP",
    kind: "generic-mcp",
  },
];

export function providersForMode(mode: AttachMode): ProviderChoice[] {
  return HABITAT_PROVIDERS.filter((row) => row.mode === mode);
}

export function findProvider(id: string): ProviderChoice | undefined {
  return HABITAT_PROVIDERS.find((row) => row.id === id);
}

export function visibleAttachFields(mode: AttachMode, providerId: string): ProviderFields {
  const provider = findProvider(providerId);
  if (!provider || provider.mode !== mode) {
    return {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "hidden",
      vendorBaseUrl: "hidden",
      modelId: "hidden",
    };
  }
  return provider.fields;
}

export function modelIdForBind(provider: ProviderChoice, typedModelId: string): string {
  const typed = typedModelId.trim();
  if (provider.fields.modelId !== "hidden") return typed;
  return provider.bindModelId ?? provider.id;
}

export function findConnector(id: string): ConnectorChoice | undefined {
  return HABITAT_CONNECTORS.find((row) => row.id === id);
}

export function connectorIdForBind(connector: ConnectorChoice, typedConnectorId: string): string {
  const typed = typedConnectorId.trim();
  if (connector.kind !== "oauth") return typed;
  return connector.bindConnectorId ?? connector.id;
}

export function isAdminAddPath(panel: "wizard" | "admin", action: "add-model" | "add-connector"): boolean {
  return panel === "wizard" && (action === "add-model" || action === "add-connector");
}
