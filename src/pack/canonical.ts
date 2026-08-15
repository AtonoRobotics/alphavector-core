/**
 * Deterministic JSON encoding for signatures.
 * Keys are sorted recursively. Signatures are excluded from the signed payload.
 */
export function canonicalPackBytes(value: unknown): Buffer {
  return Buffer.from(canonicalString(value), "utf8");
}

export function stripSignatures(document: unknown): unknown {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return document;
  }
  const copy: Record<string, unknown> = { ...(document as Record<string, unknown>) };
  delete copy.signatures;
  return copy;
}

export function canonicalString(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}
