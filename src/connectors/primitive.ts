import { SurfaceViolationError } from "../errors.js";
import type { PrincipalKind } from "../packs/types.js";

export interface ConnectorHandle {
  handleId: string;
  connectorId: string;
  /** Models receive handles, never credentials. */
  credential: never | undefined;
}

export class ConnectorBook {
  private readonly connected = new Set<string>();

  connectNewProvider(actor: PrincipalKind, connectorId: string): ConnectorHandle {
    if (actor === "field") {
      throw new SurfaceViolationError("New-provider connector auth is Architect/admin, not field");
    }
    this.connected.add(connectorId);
    return { handleId: `handle:${connectorId}`, connectorId, credential: undefined };
  }
}
