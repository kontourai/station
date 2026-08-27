/**
 * WCAG 2.x relative-luminance / contrast-ratio primitives (station#1424
 * review round 3, NEW-3). Small and dependency-free on purpose: the
 * identicon contrast gate (`__tests__/identicon-contrast.test.ts`) reads the
 * real `BrandIcon.css` token values and needs to compute the same numbers
 * the spec defines, not approximate them.
 */

/** `[h, s, l]` in degrees/0-1 -> `[r, g, b]` in 0-255. */
export function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const hueNormalized = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = hueNormalized / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hPrime < 1) [r1, g1, b1] = [c, x, 0];
  else if (hPrime < 2) [r1, g1, b1] = [x, c, 0];
  else if (hPrime < 3) [r1, g1, b1] = [0, c, x];
  else if (hPrime < 4) [r1, g1, b1] = [0, x, c];
  else if (hPrime < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0-1) of an sRGB color. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG contrast ratio (1-21) between two relative luminances. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast ratio of white (#fff) text against an HSL(deg, 0-1, 0-1) background. */
export function whiteOnHslContrast(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l);
  return contrastRatio(1, relativeLuminance(r, g, b));
}
