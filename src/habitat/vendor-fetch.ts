/**
 * Vendor HTTPS used by named subscription/connector login.
 * Tests replace this so CI never hits live vendors. Product path is global fetch.
 */
export type VendorFetch = typeof fetch;

let vendorFetchImpl: VendorFetch = (...args) => globalThis.fetch(...args);

export function vendorFetch(...args: Parameters<VendorFetch>): ReturnType<VendorFetch> {
  return vendorFetchImpl(...args);
}

export function setVendorFetch(next: VendorFetch): VendorFetch {
  const previous = vendorFetchImpl;
  vendorFetchImpl = next;
  return previous;
}

export function resetVendorFetch(): void {
  vendorFetchImpl = (...args) => globalThis.fetch(...args);
}
