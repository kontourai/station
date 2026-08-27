/**
 * The accent override and the foreground that has to stay legible on it
 * (station#3305 review finding 3).
 *
 * `--text-on-accent` is a static alias of `--k-brand-contrast` — the contrast
 * partner of the BUILT-IN brand, `#ffffff` under `[data-theme="light"]` and
 * `#06080b` in dark. Every built-in figure quoted in this file is the SHIPPED
 * token (`@kontourai/ui/tokens/tokens.css`): index.css redefines `--k-brand`
 * and `--k-brand-contrast` only under `:root.is-dev-build`, so a dev build
 * resolves different values and different ratios — measure against the vendor
 * tokens, not against index.css. Setting `--accent-primary` from the accent picker
 * changed the background under every `--text-on-accent` foreground without
 * changing the foreground, so the name promised a derivation nothing
 * computed: the shipped `#6366f1` preset landed at 4.47:1 against the light
 * theme's white (under the 4.5:1 AA floor), and the picker's free
 * `<input type="color">` can drive an arbitrary accent toward 1:1 with
 * nothing to stop it. The derived partner is theme-independent for the same
 * reason the accent is: both are stamped on the root, so switching theme
 * cannot separate them.
 *
 * So the two move together: whoever applies an accent applies its contrast
 * partner in the same call, and clearing one clears the other.
 */

/** The two foregrounds an accent can carry. Kept literal so it is testable. */
export const ACCENT_CONTRAST_LIGHT = '#ffffff';
export const ACCENT_CONTRAST_DARK = '#000000';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance, or `null` when the input is not a hex color. */
export function relativeLuminance(color: string): number | null {
  const value = color.trim();
  if (!HEX.test(value)) return null;
  const hex =
    value.length === 4
      ? value
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colors, or `null` if either is not one. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The higher-contrast of black and white on `accent`. `null` for anything that
 * is not a hex color, so the caller leaves the theme's own token in place
 * rather than stamping a guess.
 */
export function accentContrastColor(accent: string): string | null {
  const luminance = relativeLuminance(accent);
  if (luminance === null) return null;
  const onWhite = 1.05 / (luminance + 0.05);
  const onBlack = (luminance + 0.05) / 0.05;
  return onBlack > onWhite ? ACCENT_CONTRAST_DARK : ACCENT_CONTRAST_LIGHT;
}

/** How far the hover fill moves away from the accent's own foreground. */
const HOVER_SHIFT = 0.12;

function toHex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
}

function channels(hex: string): [number, number, number] {
  const body =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1);
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ];
}

/**
 * The hover fill for a custom accent, or `null` for a non-hex accent.
 *
 * Both themes define `--accent-darker` as `var(--k-brand)` — the same value as
 * `--accent-primary` — so for the built-in brand the accented hover rules
 * change no color at all. A custom accent only overrode `--accent-primary`,
 * which turned that no-op into a revert: hover swapped the fill back to the
 * built-in brand while the foreground stayed the partner derived for the
 * CUSTOM accent (measured against the shipped light brand `#0e7c64`: every
 * preset hovered at 4.09:1, below AA and below the 5.14:1 it replaced).
 *
 * The shift is always AWAY from the accent's own foreground — lighter under a
 * dark foreground, darker under a light one. That direction can only raise the
 * pairing's contrast, so one foreground clears both states by construction;
 * moving toward the foreground instead cannot (`#6366f1` rests at 4.70:1, so
 * any perceptible darkening under black text drops it under 4.5:1).
 *
 * Near-extreme accents are already so close to the shift target that 12%
 * rounds to the same bytes, so hover is a no-op there: no contrast harm, but
 * no hover feedback either. Rare — 3 of 202k sampled sRGB values, plus pure
 * white and pure black — and only reachable through the picker's free colour
 * input, never a preset.
 */
export function accentHoverFill(accent: string): string | null {
  const contrast = accentContrastColor(accent);
  if (!contrast) return null;
  const target = contrast === ACCENT_CONTRAST_DARK ? 255 : 0;
  const [r, g, b] = channels(accent.trim());
  const shift = (c: number) => c + (target - c) * HOVER_SHIFT;
  return `#${toHex(shift(r))}${toHex(shift(g))}${toHex(shift(b))}`;
}

/**
 * Apply (or clear) the accent override, its contrast partner, and the hover
 * fill that partner has to survive — together. Used by the boot fast path in
 * `main.tsx` and by `AccentColorPicker`'s value-keyed effect, so an accent set
 * on either path carries a legible foreground in both states.
 */
export function applyAccentColor(
  root: HTMLElement,
  accent: string | null | undefined,
): void {
  if (!accent) {
    root.style.removeProperty('--accent-primary');
    root.style.removeProperty('--text-on-accent');
    root.style.removeProperty('--accent-hover-fill');
    return;
  }
  root.style.setProperty('--accent-primary', accent);
  const contrast = accentContrastColor(accent);
  const hover = accentHoverFill(accent);
  if (contrast) root.style.setProperty('--text-on-accent', contrast);
  else root.style.removeProperty('--text-on-accent');
  if (hover) root.style.setProperty('--accent-hover-fill', hover);
  else root.style.removeProperty('--accent-hover-fill');
}
