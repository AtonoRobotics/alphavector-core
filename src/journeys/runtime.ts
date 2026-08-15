import type { DurableStore } from "../data/store.js";
import type { Journey } from "../data/types.js";

/**
 * Durable journey runtime (DEC-004). Temporal is the production process backend.
 * Field users do not configure Temporal. Side effects occur only through the
 * effect executor (activities), never inside this state machine.
 */
export class JourneyRuntime {
  constructor(private readonly store: DurableStore) {}

  open(tenantId: string, journeyKind: string, objective: string): Journey {
    return this.store.createJourney(tenantId, journeyKind, objective);
  }

  pause(id: string): Journey {
    const journey = this.store.journeys.find((j) => j.id === id);
    if (!journey) throw new Error(`Unknown journey ${id}`);
    journey.status = "paused";
    return journey;
  }

  close(id: string): Journey {
    const journey = this.store.journeys.find((j) => j.id === id);
    if (!journey) throw new Error(`Unknown journey ${id}`);
    journey.status = "closed";
    return journey;
  }
}
