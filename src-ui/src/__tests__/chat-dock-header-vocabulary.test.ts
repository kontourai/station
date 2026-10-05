/**
 * the bottom dock bar mixed five control vocabularies
 * (a bare-text ⌘D/⌃⌘M keycap hint, a drag-handle glyph, icon buttons, a
 * green monospace "No project ~ (defaults to home)" status segment, and an
 * underlined "Start a chat" link) where two families — icon buttons and one
 * plain-text status segment — would say the same things. This pins the
 * three concrete normalizations against the CSS source: jsdom does not
 * verify browser layout. These assertions constrain source declarations;
 * they do not prove the painted color, font, or text decoration.
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
});

describe('chat dock header buttons are quiet (design round 2026-10, B1)', () => {
  test('the collapsed bar’s New chat has no override and the bar’s buttons draw no border at rest', () => {
    const overrides = ruleBodiesFor(
      indexCss,
      '.chat-dock__header-actions button.chat-dock__collapsed-new',
    );
    expect(overrides).toHaveLength(0);
    const shared = ruleBodiesFor(
      indexCss,
      '.chat-dock__header-actions button',
    ).join('\n');
    expect(shared).toContain('border: 1px solid transparent');
    expect(shared).not.toMatch(/border:\s*1px solid var\(/);
    expect(firstRuleFor('.chat-dock__new')).toContain(
      'border: 1px solid transparent',
    );
  });
});

describe('chat dock project status segment (station audit F6)', () => {
  const badge = firstRuleFor('.chat-dock__project-badge');

  test('the project badge no longer carries the unconditional accent-green — it reads as muted status text', () => {
    expect(badge).not.toMatch(/color:\s*var\(--accent-primary\)/);
  });

  test('the badge reads in the row’s own font, not a second family', () => {
    // F6's finding was that the badge encoded no state in its colour and read as
    // a colored label rather than as text; its remedy was the muted tone plus the
    // MONOSPACE family, chosen because the badge then shared a row with a visible
    // directory path. #1536 F removed that path (it is the badge's tooltip), and
    // #1552 D3 finished the job: with nothing monospace left beside it, a second
    // type family in a 38px bar was the only thing that family bought. The chip
    // inherits, so the bar has one font.
    //
    // The part of F6 that still holds is asserted next door: the tone is neutral,
    // not the accent green a READY badge uses.
    expect(badge).toMatch(/font-family:\s*inherit/);
    expect(badge).not.toMatch(/var\(--font-mono\)/);
    // Its surviving neighbour, the mismatch lead-in, keeps the monospace family
    // deliberately: archive#4525 gave it that treatment because it names a
    // DIVERGENCE between the session's project and the badge's, and it is the
    // only place in this row that still prints an identifier verbatim.
    expect(firstRuleFor('.chat-dock__project-session-name')).toMatch(
      /font-family:\s*var\(--font-mono\)/,
    );
  });
});
