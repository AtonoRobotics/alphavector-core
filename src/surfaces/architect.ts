import type { ArchitectHome } from "./types.js";

export class ArchitectSurface {
  home(): ArchitectHome {
    return {
      grants: true,
      packLoad: true,
      evaluation: true,
      connectors: true,
      fieldOwnerAuth: false,
    };
  }
}
