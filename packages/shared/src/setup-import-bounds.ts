/** One public bound for the content-free existing-setup import contract. */
export const SETUP_IMPORT_MAX_ITEMS = 32;
/** UUID preview ids plus the source filename/digest discriminator stay bounded. */
export const SETUP_IMPORT_MAX_SOURCE_ID_LENGTH = 600;
/** Skill names are a single path segment; keep the API and UI finite too. */
export const SETUP_IMPORT_MAX_TARGET_NAME_LENGTH = 128;

/**
 * Keys that must never be used as a skill name. `JSON.parse` yields
 * `__proto__` as an own property, but assigning to it on an ordinary object
 * hits `Object.prototype`'s accessor instead of creating one — the usage
 * counter reported a run and persisted nothing, forever.
 */
export const PROTOTYPE_AFFECTING_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

/**
 * Station's skill-name rule: a single path segment, never a traversal, and
 * never a key that behaves differently from an ordinary one. The server
 * enforces it on every create and rename; the Codex import dialog checks the
 * same rule before it sends a name, so both read it from here.
 */
export function isSafeSkillName(name: string): boolean {
  return (
    name.trim() !== '' &&
    name.length <= SETUP_IMPORT_MAX_TARGET_NAME_LENGTH &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    name !== '.' &&
    !PROTOTYPE_AFFECTING_KEYS.includes(name)
  );
}
