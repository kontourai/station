import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Structural guard for color literals that a palette cannot reach.
 *
 * A palette recolors the app by overriding `--k-*` and Station's functional
 * variables. A literal color in a rule ignores both, so the surface keeps its
 * original look under every palette, and a dark-only literal stays dark under
 * the light theme (the onboarding launcher and engine picker were a navy slab
 * with pale-blue text there). This pins the specific shapes that were removed
 * from the stylesheets listed below; it is not a repo-wide literal count, and
 * a stylesheet outside the list is not checked.
 */

const SRC = path.resolve(import.meta.dirname, '..');

/** Drop comments so prose that quotes a retired literal does not count. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  );
}

function findAll(css: string, pattern: RegExp): string[] {
  const text = stripComments(css);
  const hits: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    hits.push(`${line}: ${match[0]}`);
  }
  return hits;
}

/** Stylesheets whose theme-relevant literals were moved onto tokens. */
const CLEANED = [
  'index.css',
  'components/EnginePicker.css',
  'components/OnboardingGate.css',
  'components/PathAutocomplete.css',
  'components/acp-connections/ACPConnections.css',
  'components/chat/ConversationHandoff.css',
  'components/chat/chat.css',
  'components/editor-controls.css',
  'components/first-run/FirstRunHomeChapter.css',
  'components/modals/FolderBrowserModal.css',
  'components/modals/NewProjectModal.css',
  'components/voice/VoiceOrb.css',
  'components/voice/VoicePill.css',
  'pages/NotificationsPage.css',
  'views/PluginManagementView.css',
  'views/ProjectPage.css',
  'views/ProjectSettingsView.css',
  'views/ScheduleView.css',
  'views/editor-layout.css',
  'views/skills-view.css',
];

function offenders(pattern: RegExp): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const relative of CLEANED) {
    const hits = findAll(
      readFileSync(path.join(SRC, relative), 'utf8'),
      pattern,
    );
    if (hits.length > 0) result[relative] = hits;
  }
  return result;
}

// Any raw color: hex, rgb()/rgba()/hsl()/hsla(), or the named extremes.
const RAW_COLOR =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black)(?![\w-])/g;

describe('theme color literals', () => {
  test('no rgb()/rgba() wraps a custom property', () => {
    // `rgba(var(--accent-primary), 0.1)` is invalid when the variable holds a
    // hex color, so the declaration is dropped and the effect never renders.
    // Tint with `color-mix(in srgb, var(--x) N%, transparent)` instead.
    expect(offenders(/\brgba?\(\s*var\(/g)).toEqual({});
  });

  test('no surface lifts toward a literal white or black', () => {
    // Mix toward `var(--surface-lift)` (or use an elevation token): a literal
    // ignores the palette and lifts the wrong way in one of the two modes.
    expect(
      offenders(/color-mix\([^;]*?\b(?:white|black)\s*(?:\d|\))/g),
    ).toEqual({});
  });

  test('no dark-navy scrim literal', () => {
    // Scrims take `var(--overlay-modal)`, which each theme sets.
    expect(offenders(/rgba\(\s*7,\s*10,\s*16\b/g)).toEqual({});
  });

  test.each([
    'components/OnboardingGate.css',
    'components/EnginePicker.css',
    'views/skills-view.css',
  ])('%s carries no raw color at all', (relative) => {
    const css = readFileSync(path.join(SRC, relative), 'utf8');
    expect(findAll(css, RAW_COLOR)).toEqual([]);
  });
});
