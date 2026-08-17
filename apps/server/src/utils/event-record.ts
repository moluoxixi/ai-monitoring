/**
 * Treat malformed JSON nodes as empty records so event parsers can degrade
 * without duplicating object/null/array guards at every field boundary.
 */
export const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

