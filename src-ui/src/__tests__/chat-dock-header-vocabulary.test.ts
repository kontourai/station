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

  test('every shortcut hint (dock toggle, activity items, New/Open, Maximize) shares one bordered keycap treatment', () => {
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

  test('the badge and the path fallback it sits beside now share one monospace family, reading as one status segment', () => {
    const dir = firstRuleFor('.chat-dock__project-dir');
    expect(badge).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(dir).toMatch(/font-family:\s*var\(--font-mono\)/);
  });
});
