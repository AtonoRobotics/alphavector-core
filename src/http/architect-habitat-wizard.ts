export type AttachMode = "subscription" | "api";
export type FieldNeed = "required" | "optional" | "hidden" | "guided";
export type GlmPlanId = "coding" | "general";

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
  glmPlan: FieldNeed;
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
  /** Official documented vendor base. Not an Architect-typed issuer. */
  officialBaseUrl?: string;
  /** Official vendor key / console page. */
  officialKeyUrl?: string;
  billingNote?: string;
  fields: ProviderFields;
}

const HIDDEN_TYPED_URL: ProviderFields = {
  subscriptionAuth: "hidden",
  startUrl: "hidden",
  apiKey: "hidden",
  vendorBaseUrl: "hidden",
  modelId: "hidden",
  glmPlan: "hidden",
};

const KEY_PASTE_SUB: ProviderFields = {
  subscriptionAuth: "hidden",
  startUrl: "hidden",
  apiKey: "required",
  vendorBaseUrl: "hidden",
  modelId: "hidden",
  glmPlan: "hidden",
};

const API_KEY_OPTIONAL_URL: ProviderFields = {
  subscriptionAuth: "hidden",
  startUrl: "hidden",
  apiKey: "required",
  vendorBaseUrl: "optional",
  modelId: "required",
  glmPlan: "hidden",
};

/** Official xAI API base. Documented console attach; not SuperGrok session OAuth. */
export const GROK_OFFICIAL_API_BASE = "https://api.x.ai/v1";
export const GROK_OFFICIAL_CONSOLE_URL = "https://console.x.ai";

/** Official Z.ai bases. Coding Plan vs general are not interchangeable. */
export const GLM_CODING_PLAN_BASE = "https://api.z.ai/api/coding/paas/v4";
export const GLM_GENERAL_API_BASE = "https://api.z.ai/api/paas/v4";
export const GLM_OFFICIAL_KEY_URL = "https://z.ai/manage-apikey/apikey-list";

export const GLM_PLANS: Record<GlmPlanId, { label: string; officialBaseUrl: string; bindModelId: string }> = {
  coding: {
    label: "Coding Plan",
    officialBaseUrl: GLM_CODING_PLAN_BASE,
    bindModelId: "glm-coding-plan",
  },
  general: {
    label: "General",
    officialBaseUrl: GLM_GENERAL_API_BASE,
    bindModelId: "glm-subscription",
  },
};

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
      glmPlan: "hidden",
    },
  },
  {
    id: "sub-grok",
    label: "Grok Subscription",
    mode: "subscription",
    bindModelId: "grok-subscription",
    officialBaseUrl: GROK_OFFICIAL_API_BASE,
    officialKeyUrl: GROK_OFFICIAL_CONSOLE_URL,
    billingNote: "usage-billed. xAI publishes API keys, not public SuperGrok session OAuth.",
    fields: KEY_PASTE_SUB,
  },
  {
    id: "sub-glm",
    label: "GLM subscription",
    mode: "subscription",
    bindModelId: "glm-subscription",
    officialKeyUrl: GLM_OFFICIAL_KEY_URL,
    billingNote: "Official is API key only. Coding Plan and general use different official base URLs.",
    fields: {
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "hidden",
      modelId: "hidden",
      glmPlan: "required",
    },
  },
  {
    id: "api-claude",
    label: "Claude",
    mode: "api",
    fields: API_KEY_OPTIONAL_URL,
  },
  {
    id: "api-codex",
    label: "Codex",
    mode: "api",
    fields: API_KEY_OPTIONAL_URL,
  },
  {
    id: "api-grok",
    label: "Grok",
    mode: "api",
    fields: API_KEY_OPTIONAL_URL,
  },
  {
    id: "api-kimi",
    label: "Kimi",
    mode: "api",
    fields: API_KEY_OPTIONAL_URL,
  },
  {
    id: "api-glm",
    label: "GLM",
    mode: "api",
    fields: API_KEY_OPTIONAL_URL,
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
      glmPlan: "hidden",
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
    return { ...HIDDEN_TYPED_URL };
  }
  return provider.fields;
}

export function isGlmPlanId(value: string): value is GlmPlanId {
  return value === "coding" || value === "general";
}

export function modelIdForBind(provider: ProviderChoice, typedModelId: string, glmPlan?: string): string {
  if (provider.id === "sub-glm") {
    const plan = glmPlan && isGlmPlanId(glmPlan) ? GLM_PLANS[glmPlan] : undefined;
    return plan?.bindModelId ?? provider.bindModelId ?? provider.id;
  }
  const typed = typedModelId.trim();
  if (provider.fields.modelId !== "hidden") return typed;
  return provider.bindModelId ?? provider.id;
}

export function officialBaseUrlForBind(provider: ProviderChoice, glmPlan?: string): string | undefined {
  if (provider.id === "sub-glm") {
    if (!glmPlan || !isGlmPlanId(glmPlan)) return undefined;
    return GLM_PLANS[glmPlan].officialBaseUrl;
  }
  return provider.officialBaseUrl;
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
