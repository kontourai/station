/**
 * the bottom dock bar mixed five control vocabularies
 * (a bare-text ⌘D/⌃⌘M keycap hint, a drag-handle glyph, icon buttons, a
 * green monospace "No project ~ (defaults to home)" status segment, and an
 * underlined "Start a chat" link) where two families — icon buttons and one
 * plain-text status segment — would say the same things. This pins the
 * three concrete normalizations against the CSS source: jsdom does not
 * apply stylesheets or compute layout (see
 * `settings-save-pill-occlusion.test.ts`), so a real render cannot observe
 * color/font/text-decoration the way a browser paints them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ruleBodiesFor } from './helpers/css-rules';

const uiRoot = path.resolve(__dirname, '..');
const indexCss = readFileSync(path.join(uiRoot, 'index.css'), 'utf-8');

function firstRuleFor(selector: string): string {
  const bodies = ruleBodiesFor(indexCss, selector);
  if (bodies.length === 0)
    throw new Error(`No block for selector "${selector}"`);
  return bodies[0];
}

describe('chat dock header keycap hints (station audit F6)', () => {
  const subtitle = firstRuleFor('.chat-dock__subtitle');

  test('the keycap treatment that remains (the activity dropdown\u2019s per-session chords) is still the one bordered family', () => {
    // #1536 F removed the two BARE keycaps from the header bar itself — the ⌘D
    // beside the retired settings gear and the ⌘M inside Maximize — because
    // every other shortcut in this bar is a tooltip. The shared treatment still
    // has a consumer (the activity dropdown's per-session ⌘1…⌘9 rows), and one
    // treatment for all of them is what F6 was about.
    expect(subtitle).toMatch(/border:\s*1px solid/);
    expect(subtitle).toMatch(/border-radius:/);
    expect(subtitle).toMatch(/background:/);
    expect(subtitle).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  test('the per-button overrides that gave Maximize/New a different keycap color than the dock-toggle hint are gone', () => {
    // Before the fix, `.chat-dock__new .chat-dock__subtitle` and
    // `.chat-dock__maximize-btn .chat-dock__subtitle` restyled the keycap
    // with a second, different color — reverting that (re-adding a
    // divergent override) reds this.
    expect(indexCss).not.toMatch(
      /\.chat-dock__maximize-btn \.chat-dock__subtitle\s*\{[^}]*color:\s*var\(--text-secondary\)/,
    );
  });
});

describe('chat dock "Start a chat" action (station audit F6)', () => {
  test('it is no longer styled as an underlined link — it shares the bordered compact button its siblings use', () => {
    const overrides = ruleBodiesFor(
      indexCss,
      '.chat-dock__header-actions button.chat-dock__counter-action',
    );
    // Positive power: post-fix this selector has NO rules
    // at all, so the loop above is vacuous by design — pin that emptiness
    // explicitly, and pin the shared sibling rule the button now inherits.
    expect(overrides).toHaveLength(0);
    expect(
      ruleBodiesFor(indexCss, '.chat-dock__header-actions button').join('\n'),
    ).toContain('border: 1px solid');
  });
});

describe('chat dock project status segment (station audit F6)', () => {
  const badge = firstRuleFor('.chat-dock__project-badge');

  test('the project badge no longer carries the unconditional accent-green — it reads as muted status text', () => {
    expect(badge).not.toMatch(/color:\s*var\(--accent-primary\)/);
  });

  test('the badge keeps the monospace status-text family the row reads in', () => {
    // The path segment it used to share that family with is gone (#1536 F —
    // the path is the badge's tooltip now), so the pair this originally
    // compared no longer exists. The badge's own treatment is what F6 fixed and
    // is what this still pins; its surviving neighbour in the row is the muted
    // mismatch lead-in, which uses the same family.
    expect(badge).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(firstRuleFor('.chat-dock__project-session-name')).toMatch(
      /font-family:\s*var\(--font-mono\)/,
    );
  });
});
