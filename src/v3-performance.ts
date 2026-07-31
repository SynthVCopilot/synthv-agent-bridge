export const V3_PERFORMANCE_BUDGETS = Object.freeze({
  toolCatalogCharacters: 6_000,
  toolCatalogBytes: 6_000,
  ordinaryQueryCharacters: 20_000,
  ordinaryQueryBytes: 20_000,
  commandAcknowledgementCharacters: 2_048,
  commandAcknowledgementBytes: 2_048,
  publicErrorCharacters: 4_096,
  publicErrorBytes: 4_096,
  actionDescriptionCharacters: 12_000,
  actionDescriptionBytes: 12_000,
  normalTraceOverheadCharacters: 1_024,
  normalTraceOverheadBytes: 1_024,
  supportTraceCharacters: 8_192,
  supportTraceBytes: 8_192,
  debugTraceCharacters: 16_384,
  debugTraceBytes: 16_384,
});

export function serializedCharacterCount(value: unknown): number {
  return JSON.stringify(value).length;
}

export function serializedUtf8ByteCount(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate p95 for an empty sample");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] as number;
}
