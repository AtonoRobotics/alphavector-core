import type { LoadedPack } from "../pack/types.js";
import type { EgressBinding } from "./types.js";

/**
 * Packs may bind egress. Packs do not own the computer primitive.
 */
export function egressFromPack(pack: LoadedPack): EgressBinding {
  const hosts = new Set<string>();
  for (const connector of pack.document.connectors) {
    for (const host of connector.egressHosts) {
      hosts.add(host);
    }
  }
  return { hosts: [...hosts].sort() };
}

export function encodeEgressEnv(binding: EgressBinding): string {
  return binding.hosts.join(",");
}
