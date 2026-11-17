/**
 * Internal record primitives with no imports, so a contract that needs only
 * these (such as the browser-facing managed policy status) does not pull the
 * rest of `./contract-validation.js` into the UI's first-load bundle. No
 * public package subpath; `./contract-validation.js` re-exports `isRecord`.
 */

/** A plain object: not null, not an array, with no prototype but Object's. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Any non-null object that is not an array, whatever its prototype: the loose
 * form the boundary validators share. A class instance or an object with
 * accessor members passes; use `isRecord` where only a plain object may.
 */
export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `record[key]` only when it is the record's own member, never an inherited
 * one. Not `Object.hasOwn`: SDK consumers compile contracts for ES2020.
 */
export function ownMember(
  record: Record<string, unknown>,
  key: string,
): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
