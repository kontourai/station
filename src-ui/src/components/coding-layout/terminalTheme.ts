import type { ITheme } from '@xterm/xterm';

/**
 * xterm paints a canvas, so the cascade cannot reach it: its colours have to
 * be read out of the `--terminal-*` variables (index.css, one set per mode)
 * and handed over as an ITheme. TerminalPanel reads them when the terminal is
 * built and again whenever the root theme changes (`observeRootTheme`).
 */
const TERMINAL_THEME_VARIABLES: Readonly<
  Partial<Record<keyof ITheme, string>>
> = {
  background: '--terminal-background',
  foreground: '--terminal-foreground',
  cursor: '--terminal-cursor',
  selectionBackground: '--terminal-selection',
  black: '--terminal-black',
  red: '--terminal-red',
  green: '--terminal-green',
  yellow: '--terminal-yellow',
  blue: '--terminal-blue',
  magenta: '--terminal-magenta',
  cyan: '--terminal-cyan',
  white: '--terminal-white',
  brightBlack: '--terminal-bright-black',
  brightRed: '--terminal-bright-red',
  brightGreen: '--terminal-bright-green',
  brightYellow: '--terminal-bright-yellow',
  brightBlue: '--terminal-bright-blue',
  brightMagenta: '--terminal-bright-magenta',
  brightCyan: '--terminal-bright-cyan',
  brightWhite: '--terminal-bright-white',
};

/**
 * The terminal theme as `element` resolves it. A variable that resolves to
 * nothing is left out, so xterm keeps its own default for that slot rather
 * than painting an empty colour.
 */
export function readTerminalTheme(element: Element): ITheme {
  const computed = getComputedStyle(element);
  const theme: ITheme = {};
  for (const [slot, variable] of Object.entries(TERMINAL_THEME_VARIABLES)) {
    if (!variable) continue;
    const value = computed.getPropertyValue(variable).trim();
    if (value) (theme as Record<string, string>)[slot] = value;
  }
  return theme;
}
