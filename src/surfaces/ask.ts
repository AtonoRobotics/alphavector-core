import { SurfaceViolationError } from "../errors.js";
import type { DurableStore } from "../data/store.js";
import type { LoadedPack } from "../packs/types.js";
import type { AskRequest } from "./types.js";

/**
 * Optional tool path (DEC-024). Coordinator they can text, not an architecture console.
 * SHALL NOT exceed pack Ask ceilings. Not a side door around policy or cards.
 * A deny is persisted with its original reason (ceiling vs architecture console)
 * and stays denied on retry with that same message.
 */
export class AskSurface {
  private readonly denied = new Map<string, string>();

  constructor(private readonly store?: DurableStore) {}

  wasDenied(req: AskRequest): boolean {
    return this.denialReason(req) !== undefined;
  }

  assertAllowed(pack: LoadedPack, req: AskRequest): void {
    const prior = this.denialReason(req);
    if (prior) {
      throw new SurfaceViolationError(prior);
    }
    try {
      this.assertFresh(pack, req);
    } catch (err) {
      this.recordDenial(req, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private assertFresh(pack: LoadedPack, req: AskRequest): void {
    if (pack.binding.askCeilings.includes(req.actionClass)) {
      throw new SurfaceViolationError(
        `Ask path cannot authorize action class ${req.actionClass} (pack Ask ceiling)`,
      );
    }
    const lowered = req.text.toLowerCase();
    if (
      lowered.includes("pick a model") ||
      lowered.includes("edit prompt") ||
      lowered.includes("inspect temporal") ||
      lowered.includes("configure tool")
    ) {
      throw new SurfaceViolationError("Ask path is not an architecture console");
    }
  }

  private denialReason(req: AskRequest): string | undefined {
    const cached = this.denied.get(this.key(req));
    if (cached) return cached;
    if (!this.store) return undefined;
    const ev = this.store.evidence.find(
      (e) =>
        e.tenantId === req.tenantId &&
        e.kind === "ask_denied" &&
        e.payload.actionClass === req.actionClass &&
        e.payload.text === req.text,
    );
    if (!ev) return undefined;
    return typeof ev.payload.reason === "string"
      ? ev.payload.reason
      : `Ask path cannot authorize action class ${req.actionClass} (pack Ask ceiling)`;
  }

  private recordDenial(req: AskRequest, reason: string): void {
    this.denied.set(this.key(req), reason);
    this.store?.addEvidence({
      tenantId: req.tenantId,
      kind: "ask_denied",
      payload: { actionClass: req.actionClass, text: req.text, reason },
      producedBy: "ask",
    });
  }

  private key(req: AskRequest): string {
    return `${req.tenantId}\0${req.actionClass}\0${req.text}`;
  }
}
