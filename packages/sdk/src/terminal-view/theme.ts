/**
 * The terminal theme as the page's design tokens resolve it. The canvas
 * cannot follow the cascade, so colours are read from computed style:
 * surface, text, focus and action from `--k-*` tokens, the ANSI palette from
 * a host's `--terminal-*` variables when it defines them. The view re-reads
 * the theme whenever the root's theme attributes change.
 */

import type { TerminalTheme } from './render/screen-model';

const ANSI_VARIABLES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
].map((name) => `--terminal-${name}`);

/** Readable defaults for the 16 ANSI slots when the host defines none. */
const DEFAULT_ANSI = {
  dark: [
    0x1d1f21, 0xf0625f, 0x5fd38d, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2,
    0xd7dae0, 0x6b7280, 0xff7b72, 0x7ee787, 0xf2cc60, 0x79c0ff, 0xd2a8ff,
    0x76e3ea, 0xffffff,
  ],
  light: [
    0x24292f, 0xb42318, 0x116329, 0x7d4e00, 0x0550ae, 0x8250df, 0x0b6e74,
    0x6e7781, 0x57606a, 0xc9311f, 0x1a7f37, 0x8a5a00, 0x0969da, 0x8f4ad6,
    0x1b7c83, 0x8c959f,
  ],
} as const;

let probe: CanvasRenderingContext2D | null = null;

/** Any CSS colour (including `color-mix`, `oklch`) to packed RGB, or null. */
export function cssColorToRgb(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  probe ??= document.createElement('canvas').getContext('2d');
  if (probe) {
    probe.fillStyle = '#000001';
    probe.fillStyle = text;
    const resolved = String(probe.fillStyle);
    if (resolved !== '#000001' || text === '#000001')
      return resolved.startsWith('#')
        ? Number.parseInt(resolved.slice(1, 7), 16)
        : parseRgb(resolved);
  }
  // No 2D context, or a colour it does not accept: let the cascade resolve it.
  const el = document.createElement('span');
  el.style.color = text;
  document.body.append(el);
  const computed = getComputedStyle(el).color;
  el.remove();
  return parseRgb(computed) ?? parseHex(computed);
}

function parseHex(value: string): number | null {
  const match = value.trim().match(/^#([0-9a-f]{6})$/i);
  return match ? Number.parseInt(match[1]!, 16) : null;
}

function parseRgb(value: string): number | null {
  const match = value.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (!match) return null;
  return (Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3]);
}

/** WCAG relative luminance of a packed colour. */
export function luminance(color: number): number {
  const channel = (shift: number) => {
    const c = ((color >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

export function contrast(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Moves `fg` toward black or white until it reaches `minimum` contrast
 * against `bg`. Program colours that are unreadable on the current theme
 * (dark blue on a dark surface) stay recognisable but legible.
 */
export function ensureContrast(
  fg: number,
  bg: number,
  minimum: number,
): number {
  if (contrast(fg, bg) >= minimum) return fg;
  const target = luminance(bg) > 0.5 ? 0x000000 : 0xffffff;
  for (let t = 0.1; t <= 1; t += 0.1) {
    const mixed = mix(fg, target, t);
    if (contrast(mixed, bg) >= minimum) return mixed;
  }
  return target;
}

function mix(a: number, b: number, t: number): number {
  const lerp = (shift: number) =>
    Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t) <<
    shift;
  return lerp(16) | lerp(8) | lerp(0);
}

export function readTerminalTheme(element: Element): TerminalTheme {
  const style = getComputedStyle(element);
  const read = (...names: string[]) => {
    for (const name of names) {
      const color = cssColorToRgb(style.getPropertyValue(name));
      if (color !== null) return color;
    }
    return null;
  };
  const background =
    read('--terminal-background', '--k-panel', '--k-bg') ?? 0x111318;
  const scheme = luminance(background) > 0.4 ? 'light' : 'dark';
  const foreground = ensureContrast(
    read('--terminal-foreground', '--k-text') ??
      (scheme === 'dark' ? 0xe6e6e6 : 0x1f2328),
    background,
    7,
  );
  const cursor = ensureContrast(
    read('--terminal-cursor', '--k-focus', '--k-action') ?? foreground,
    background,
    3,
  );
  const selectionBackground =
    read('--terminal-selection') ??
    mix(background, cursor, scheme === 'dark' ? 0.35 : 0.25);
  // Normal ANSI text must stay readable on the terminal surface (AA 4.5:1);
  // index 0 / 8 are background-ish slots and keep the weaker 3:1 floor.
  const ansi = ANSI_VARIABLES.map((name, i) => {
    const color = read(name) ?? DEFAULT_ANSI[scheme][i]!;
    return ensureContrast(color, background, i === 0 || i === 8 ? 3 : 4.5);
  });
  return {
    foreground,
    background,
    cursor,
    cursorText: background,
    selectionBackground,
    selectionForeground:
      contrast(foreground, selectionBackground) >= 4.5 ? null : background,
    ansi,
    scheme,
  };
}

const ROOT_ATTRIBUTES = [
  'data-theme',
  'data-color-theme',
  'data-color-theme-flavor',
  'data-color-theme-accent',
  'data-app-channel',
  'data-brand-focus',
  'class',
  'style',
];

/** Calls `onChange` when anything on `<html>` that feeds colour changes. */
export function observeThemeChanges(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ROOT_ATTRIBUTES,
  });
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener?.('change', onChange);
  };
}
