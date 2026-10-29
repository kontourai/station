/**
 * The Shiki theme every Station highlighter uses: github-dark's scope rules,
 * with each of its colours replaced by the Station variable that owns that
 * role (`--syntax-*` in index.css).
 *
 * Highlighted output therefore carries `var(--syntax-keyword)` instead of
 * `#F97583`, so the light theme, palette themes and branding all reach code
 * blocks through the cascade, and the same HTML is correct in every theme. A
 * cache of highlighted HTML needs no theme in its key, and nothing has to be
 * re-highlighted when the theme changes.
 *
 * Shiki's own `createCssVariablesTheme` was the other option. Its scope set is
 * coarser than github-dark's (quoted strings and JSX tags share one variable,
 * for example), so deriving from github-dark keeps today's token grouping and
 * only moves the pigments into tokens.
 *
 * Lazy: imported by the highlighter factories, never by the entry chunk.
 */
import githubDark from '@shikijs/themes/github-dark';
import type { ThemeRegistration } from '@shikijs/types';
import { SYNTAX_FOREGROUND, THEME } from './shared';

export const STATION_SYNTAX_THEME_NAME = THEME;
export const STATION_DIFF_THEME_NAME = 'station-diff';

export { SYNTAX_FOREGROUND };

/**
 * github-dark's palette (lower-case hex, as the theme file spells it) mapped
 * to Station roles. Every colour github-dark uses must appear here; the
 * station-syntax-theme test fails on one that does not.
 */
export const GITHUB_DARK_ROLE_BY_COLOR: Readonly<Record<string, string>> = {
  '#f97583': 'var(--syntax-keyword)',
  '#9ecbff': 'var(--syntax-string)',
  '#dbedff': 'var(--syntax-string)',
  '#79b8ff': 'var(--syntax-number)',
  '#b392f0': 'var(--syntax-function)',
  '#85e89d': 'var(--syntax-tag)',
  '#ffab70': 'var(--syntax-variable)',
  '#6a737d': 'var(--syntax-comment)',
  '#2f363d': 'var(--syntax-comment)',
  '#fdaeb7': 'var(--syntax-deleted)',
  '#e1e4e8': SYNTAX_FOREGROUND,
  '#d1d5da': SYNTAX_FOREGROUND,
  '#24292e': 'var(--syntax-background)',
  // Backgrounds of inserted / deleted / changed markup (diff fences): a tint
  // of the matching foreground role, so they follow it.
  '#144620': 'color-mix(in srgb, var(--syntax-tag) 20%, transparent)',
  '#86181d': 'color-mix(in srgb, var(--syntax-deleted) 20%, transparent)',
  '#c24e00': 'color-mix(in srgb, var(--syntax-variable) 20%, transparent)',
};

type TokenColor = NonNullable<ThemeRegistration['tokenColors']>[number];

function role(color: string | undefined): string | undefined {
  if (!color) return color;
  return GITHUB_DARK_ROLE_BY_COLOR[color.toLowerCase()] ?? SYNTAX_FOREGROUND;
}

function stationTokenColors(): TokenColor[] {
  return (githubDark.tokenColors ?? []).map((rule) => {
    const settings = { ...rule.settings };
    if (settings.foreground) settings.foreground = role(settings.foreground);
    if (settings.background) settings.background = role(settings.background);
    return { ...rule, settings };
  });
}

/** Chat code blocks and the File Preview. */
export function createStationSyntaxTheme(): ThemeRegistration {
  return {
    name: STATION_SYNTAX_THEME_NAME,
    type: 'dark',
    colors: {
      'editor.foreground': SYNTAX_FOREGROUND,
      'editor.background': 'var(--syntax-background)',
    },
    tokenColors: stationTokenColors(),
  };
}

/**
 * The diff viewer (@pierre/diffs). Same token rules; the surface and the
 * added/removed/modified tones come from the `--diff-*` variables, which
 * @pierre/diffs reads from these `colors` keys.
 */
export function createStationDiffTheme(): ThemeRegistration {
  return {
    name: STATION_DIFF_THEME_NAME,
    type: 'dark',
    colors: {
      'editor.foreground': SYNTAX_FOREGROUND,
      'editor.background': 'var(--diff-background)',
      'gitDecoration.addedResourceForeground': 'var(--diff-addition)',
      'gitDecoration.deletedResourceForeground': 'var(--diff-deletion)',
      'gitDecoration.modifiedResourceForeground': 'var(--diff-modified)',
    },
    tokenColors: stationTokenColors(),
  };
}
