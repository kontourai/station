import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * station#3309 motion polish. The dock's chrome, its inbox panel and its
 * background-tasks sheet all animate now, and every one of them has to satisfy
 * two contracts that a passing render cannot show you: the motion grammar
 * (`docs/design/motion.md` — token durations/easings, never literals, never
 * `transition: all`).
 *
 * The universal tokens.css reduced-motion rule clamps duration and iteration
 * count for every primitive; local declarations would only duplicate it.
 */

const SRC = path.resolve(import.meta.dirname, '..');
// Comments are stripped: these rules carry long explanatory blocks that sit
// between the selector and its declarations, and a comment mentioning
// `animation` is not an animation.
const read = (...parts: string[]) =>
  readFileSync(path.join(SRC, ...parts), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

/** Every rule body the selector participates in, inside `scope`. */
function rulesFor(scope: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|[,{}\\n])\\s*[^{}]*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`,
    'g',
  );
  const bodies: string[] = [];
  let match: RegExpExecArray | null = rule.exec(scope);
  while (match !== null) {
    bodies.push(match[1]);
    match = rule.exec(scope);
  }
  return bodies;
}

const indexCss = read('index.css');
const inboxCss = read('components', 'chat-dock', 'ChatDockInboxPanel.css');
const sheetCss = read('components', 'chat-dock', 'BackgroundTasksSheet.css');

const ANIMATED: Array<[label: string, source: string, selector: string]> = [
  ['dock header workspace controls', indexCss, '.chat-dock__header-workspace'],
  ['dock header context meter', indexCss, '.chat-dock__header-meter'],
  ['dock header Open/New pair', indexCss, '.chat-dock__tab-actions'],
  ['inbox panel entrance', inboxCss, '.chat-dock-inbox'],
  ['inbox panel exit', inboxCss, '.chat-dock-inbox--exiting'],
  ['background tasks sheet', sheetCss, '.background-tasks-sheet-panel'],
];

describe('station#3309 chat dock motion', () => {
  test('uses the universal reduced-motion primitive', () => {
    const tokens = read('tokens.css');
    const start = tokens.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThanOrEqual(0);
    const open = tokens.indexOf('{', start);
    expect(open).toBeGreaterThanOrEqual(0);
    let depth = 1;
    let index = open + 1;
    while (index < tokens.length && depth) {
      if (tokens[index] === '{') depth++;
      else if (tokens[index] === '}') depth--;
      index++;
    }
    expect(depth).toBe(0);
    const media = tokens.slice(open + 1, index - 1);
    const rule =
      media.match(/\*,\s*\*::before,\s*\*::after\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(rule).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(rule).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(rule).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  test.each(ANIMATED)(
    '%s animates on motion tokens, never a literal duration or easing',
    (_label, source, selector) => {
      const declarations = rulesFor(source, selector)
        .flatMap((body) => body.split(';'))
        .filter((declaration) => /^\s*animation\s*:/.test(declaration))
        .filter((declaration) => !/none/.test(declaration));
      expect(
        declarations.length,
        `expected an animation declaration on "${selector}"`,
      ).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration).toMatch(/var\(--motion-/);
        expect(declaration).toMatch(/var\(--ease-/);
        expect(declaration).not.toMatch(/\d+m?s\b/);
      }
    },
  );

  test('every new keyframe set the dock references is actually defined', () => {
    for (const [keyframe, source] of [
      ['chat-dock-chrome-enter', indexCss],
      ['chat-dock-inbox-enter', inboxCss],
      ['chat-dock-inbox-exit', inboxCss],
      ['background-tasks-sheet-enter', sheetCss],
    ] as const) {
      expect(source, `missing @keyframes ${keyframe}`).toContain(
        `@keyframes ${keyframe}`,
      );
    }
  });

  test('the glyphs that answer "which way is the dock going" both turn', () => {
    // Adjacent controls behaving differently is the polish complaint itself:
    // the desktop collapse chevron always rotated, its two siblings snapped.
    for (const selector of [
      '.chat-dock__chevron-svg',
      '.chat-dock__maximize-glyph',
      '.chat-dock__mobile-dock-toggle-glyph',
    ]) {
      const bodies = rulesFor(indexCss, selector);
      const transitions = bodies
        .flatMap((body) => body.split(';'))
        .filter((declaration) => /^\s*transition\s*:/.test(declaration));
      expect(
        transitions.some((declaration) =>
          /transform\s+var\(--motion-[\w-]+\)\s+var\(--ease-[\w-]+\)/.test(
            declaration,
          ),
        ),
        `expected a token-timed transform transition on "${selector}"`,
      ).toBe(true);
    }
  });
});
