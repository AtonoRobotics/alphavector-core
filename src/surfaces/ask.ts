import { SurfaceViolationError } from "../errors.js";
import type { DurableStore } from "../data/store.js";
import type { LoadedPack } from "../packs/types.js";
import type { AskRequest } from "./types.js";

/**
 * Optional tool path (DEC-024). Coordinator they can text, not an architecture console.
 * SHALL NOT exceed pack Ask ceilings. Not a side door around policy or cards.
 * A ceiling deny is persisted and stays denied on retry.
 */
export class AskSurface {
  private readonly denied = new Set<string>();

  constructor(private readonly store?: DurableStore) {}

  wasDenied(req: AskRequest): boolean {
    if (this.denied.has(this.key(req))) return true;
    if (!this.store) return false;
    return this.store.evidence.some(
      (e) =>
        e.tenantId === req.tenantId &&
        e.kind === "ask_denied" &&
        e.payload.actionClass === req.actionClass &&
        e.payload.text === req.text,
    );
  }

  assertAllowed(pack: LoadedPack, req: AskRequest): void {
    if (this.wasDenied(req)) {
      throw new SurfaceViolationError(
        `Ask path cannot authorize action class ${req.actionClass} (pack Ask ceiling)`,
      );
    }
    try {
      this.assertFresh(pack, req);
    } catch (err) {
      this.recordDenial(req);
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

  private recordDenial(req: AskRequest): void {
    this.denied.add(this.key(req));
    this.store?.addEvidence({
      tenantId: req.tenantId,
      kind: "ask_denied",
      payload: { actionClass: req.actionClass, text: req.text },
      producedBy: "ask",
    });
  }

  private key(req: AskRequest): string {
    return `${req.tenantId}\0${req.actionClass}\0${req.text}`;
  }
}
