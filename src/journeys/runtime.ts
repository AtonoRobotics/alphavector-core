import { AvError } from "../errors.js";
import { nowIso } from "../ids.js";
import type { DurableStore } from "../data/store.js";
import type { Journey } from "../data/types.js";

/**
 * Durable journey runtime (DEC-004). Temporal is the production process backend.
 * Field users do not configure Temporal. Side effects occur only through the
 * effect executor (activities), never inside this state machine.
 * Kinds stay pack strings; this runtime does not bind them.
 */
export class JourneyRuntime {
  constructor(private readonly store: DurableStore) {}

  open(tenantId: string, journeyKind: string, objective: string): Journey {
    return this.store.createJourney(tenantId, journeyKind, objective);
  }

  progress(id: string): Journey {
    const journey = this.require(id);
    if (journey.status !== "open") {
      throw new AvError("JOURNEY_NOT_OPEN", `Journey ${id} is ${journey.status}`);
    }
    journey.version += 1;
    journey.updatedAt = nowIso();
    return journey;
  }

  pause(id: string): Journey {
    const journey = this.require(id);
    journey.status = "paused";
    return journey;
  }

  close(id: string): Journey {
    const journey = this.require(id);
    journey.status = "closed";
    return journey;
  }

  private require(id: string): Journey {
    const journey = this.store.journeys.find((j) => j.id === id);
    if (!journey) throw new AvError("JOURNEY_NOT_FOUND", `Unknown journey ${id}`);
    return journey;
  }
}
