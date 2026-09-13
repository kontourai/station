/**
 * A string with at least one non-whitespace character.
 *
 * The three JSON-backed stores that validate caller-supplied records
 * (webhooks, and the two Discord stores) had each written this, and each
 * relies on the `trim()`: a field that is present but blank must be refused
 * exactly as an absent one is.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
