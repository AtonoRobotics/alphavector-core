import { FailClosedError } from "../errors.js";

export type ModelPurpose = "ask" | "agent_turn" | "eval";

export interface ModelHandle {
  purpose: ModelPurpose;
  provider: string;
  name: string;
}

/**
 * Field users do not configure models (DEC-020).
 * The OS fails closed if no binder is installed by the operator/pack.
 */
export interface ModelBinder {
  resolve(tenantId: string, purpose: ModelPurpose): Promise<ModelHandle>;
}

export class FailClosedModelBinder implements ModelBinder {
  async resolve(): Promise<ModelHandle> {
    throw new FailClosedError(
      "MODEL_BINDER_MISSING",
      "No model binder is installed. Field users cannot configure models.",
    );
  }
}

export class StaticModelBinder implements ModelBinder {
  constructor(private readonly handle: ModelHandle) {}
  async resolve(_tenantId: string, purpose: ModelPurpose): Promise<ModelHandle> {
    return { ...this.handle, purpose };
  }
}
