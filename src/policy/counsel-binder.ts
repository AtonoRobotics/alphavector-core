import { createHash } from "node:crypto";
import { FailClosedError } from "../errors.js";
import { packPayloadBytes, verifyBytes } from "../pack/signature.js";
import type { LoadedPack } from "../pack/types.js";
import type { CounselSignedPolicyInstance } from "./types.js";

/**
 * Production policy bodies are tenant-specific and counsel-signed.
 * Without a bound instance the gateway fails closed.
 */
export interface CounselPolicyBinder {
  bind(tenantId: string, pack: LoadedPack): Promise<CounselSignedPolicyInstance>;
}

export class MissingCounselPolicyError extends FailClosedError {
  constructor() {
    super(
      "POLICY_BINDER_MISSING",
      "No counsel-signed policy instance is bound for this tenant. Fail closed.",
    );
    this.name = "MissingCounselPolicyError";
  }
}

export class FailClosedCounselBinder implements CounselPolicyBinder {
  async bind(): Promise<CounselSignedPolicyInstance> {
    throw new MissingCounselPolicyError();
  }
}

export class StaticCounselBinder implements CounselPolicyBinder {
  constructor(private readonly instance: CounselSignedPolicyInstance) {}

  async bind(tenantId: string, pack: LoadedPack): Promise<CounselSignedPolicyInstance> {
    if (this.instance.tenantId !== tenantId) {
      throw new MissingCounselPolicyError();
    }
    if (
      this.instance.packId !== pack.document.identity.packId ||
      this.instance.packVersion !== pack.document.identity.version
    ) {
      throw new FailClosedError("POLICY_PACK_MISMATCH", "Counsel policy instance does not match the active pack.");
    }
    const hash = createHash("sha256").update(packPayloadBytes(pack.document)).digest("hex");
    if (hash !== this.instance.policyBodyHash) {
      throw new FailClosedError("POLICY_HASH_MISMATCH", "Counsel policy hash does not match the loaded pack.");
    }
    const payload = Buffer.from(
      `${this.instance.tenantId}:${this.instance.packId}:${this.instance.packVersion}:${this.instance.policyBodyHash}`,
      "utf8",
    );
    if (!verifyBytes(this.instance.publicKey, payload, this.instance.signature)) {
      throw new FailClosedError("POLICY_COUNSEL_UNSIGNED", "Counsel signature is invalid.");
    }
    return this.instance;
  }
}

export function counselPayload(instance: Omit<CounselSignedPolicyInstance, "signature" | "publicKey">): Buffer {
  return Buffer.from(
    `${instance.tenantId}:${instance.packId}:${instance.packVersion}:${instance.policyBodyHash}`,
    "utf8",
  );
}
