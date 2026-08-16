import type { WakeEvent } from "./types.js";

export type WakeHandler = (event: WakeEvent) => void;

/**
 * Event-driven wake bus. The orchestrator SHALL NOT poll.
 */
export class WakeBus {
  private readonly handlers: WakeHandler[] = [];

  emit(event: WakeEvent): void {
    for (const handler of [...this.handlers]) {
      handler(event);
    }
  }

  subscribe(handler: WakeHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }
}
