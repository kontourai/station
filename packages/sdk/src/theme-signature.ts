/**
 * What on `<html>` can change resolved colours, and a signature of it that
 * ignores geometry-only writes. Shared by the terminal view's palette
 * observer and the app's root-theme store, so the two agree on what counts
 * as a theme change.
 */

/** The attributes on `<html>` whose value can change resolved colours. */
export const ROOT_THEME_ATTRIBUTES = [
  'data-theme',
  'data-color-theme',
  'data-color-theme-flavor',
  'data-color-theme-accent',
  'data-app-channel',
  'data-brand-focus',
  'class',
  'style',
] as const;

// Exponents included: the visual-viewport inset is written straight from a
// float and can read `1.1368683772161603e-13px` mid keyboard animation.
const BARE_LENGTH = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(px)?$/;

/**
 * A string that changes whenever the root's colour inputs change and stays
 * the same across geometry-only inline style writes (the keyboard inset,
 * region clearances, safe areas): those are bare lengths, and no colour is.
 */
export function rootThemeSignature(root: HTMLElement): string {
  const parts: string[] = [];
  for (const name of ROOT_THEME_ATTRIBUTES) {
    if (name === 'style') continue;
    parts.push(`${name}=${root.getAttribute(name) ?? ''}`);
  }
  const declarations: string[] = [];
  for (let index = 0; index < root.style.length; index += 1) {
    const property = root.style.item(index);
    const value = root.style.getPropertyValue(property).trim();
    if (BARE_LENGTH.test(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  declarations.sort();
  parts.push(`style=${declarations.join(';')}`);
  return parts.join('|');
}
