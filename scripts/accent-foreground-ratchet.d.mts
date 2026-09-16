/**
 * Types for the gate's detector, so the measurement test in
 * `src-ui/src/__tests__/accent-fill-foreground.test.ts` can import the same
 * reading the gate uses instead of re-deriving one that would drift from it.
 */
/**
 * Every directory the gate scans. Exported so a test that builds a scratch
 * tree seeds it from this list rather than a copy: the gate `scandir`s each
 * root, so a scratch repo missing one dies with ENOENT, and a hand-written
 * copy has no way to notice a root being added (#1542 added one and only
 * Nightly failed).
 */
export const ACCENT_FOREGROUND_SOURCE_ROOTS: readonly string[];

export interface AccentFilledRule {
  path: string;
  selector: string;
  /** Which fill family, and therefore which derived partner is required. */
  fill: 'accent' | 'yellow';
  /** The exact token the background resolves to. */
  fillToken: string;
  /** The `color` value as declared. */
  foreground: string;
  /** True when `foreground` is the fill family's partner with no fallback. */
  derived: boolean;
}

export interface AccentForegroundOffender {
  path: string;
  selector: string;
  fill: 'accent' | 'yellow';
  foreground: string;
}

export function findAccentFilledRules(
  css: string,
  path: string,
): AccentFilledRule[];

export function discoverAccentFilledRules(root?: string): AccentFilledRule[];

export function discoverAccentForegroundOffenders(
  root?: string,
): AccentForegroundOffender[];

export function validateAccentForegroundInventory(
  root?: string,
  inventoryPath?: string,
): { total: number };
