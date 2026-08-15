import { SurfaceViolationError } from "../errors.js";
import type { LoadedPack } from "../packs/types.js";
import type { AskRequest } from "./types.js";

/**
 * Optional tool path (DEC-024). Coordinator they can text, not an architecture console.
 * SHALL NOT exceed pack Ask ceilings. Not a side door around policy or cards.
 */
export class AskSurface {
  assertAllowed(pack: LoadedPack, req: AskRequest): void {
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
}
