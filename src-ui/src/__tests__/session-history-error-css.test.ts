/**
 * @vitest-environment node
 *
 * station#3427 review round 2. Nothing in this repo's test suite rendered
 * `ChatDockBody`'s history-failure notice before this file, so an
 * independent-review fault injection that deleted the whole
 * `.session-history-error` CSS block left 13 files / 172 tests passing — the
 * bundle ceiling cannot catch it either, since a ceiling is a maximum and
 * deleting CSS only lowers the measurement. These are CSS-shaped assertions
 * for the same reason `mobile-chrome-safety.test.ts`'s are: the geometry and
 * the wrap/clamp policy are authored in the stylesheet, and jsdom does not
 * lay them out.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_SRC = join(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(UI_SRC, relativePath), 'utf-8');
}

function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'g',
  );
  for (const match of css.matchAll(pattern)) bodies.push(match[1]);
  return bodies;
}

describe('the chat dock history-failure notice (station#3427)', () => {
  it('is a flex child, defensively floored to shrink below its content width', () => {
    const [rule] = ruleBodies(read('index.css'), '.session-history-error');
    expect(rule, 'missing .session-history-error rule').toBeDefined();
    // Review round 2, LOW-2: measured with `min-width: auto` forced, every
    // geometry metric was identical — `.chat-dock__body` is a column flex
    // container, so this notice's auto min-size floor binds min-height, not
    // min-width, and `auto` already computes to 0 on this axis. The rule is
    // inert today; kept to match `.session-failure`'s own rule defensively,
    // in case this notice is ever placed in a row-direction flex parent.
    expect(rule).toMatch(/min-width:\s*0/);
  });

  it('wraps and clamps the recorded reason instead of widening the pane (the #3203 policy)', () => {
    const css = read('index.css');
    const [rule] = ruleBodies(css, '.session-history-error__detail');
    expect(
      rule,
      'missing .session-history-error__detail rule — the span holding transcript.error?.message',
    ).toBeDefined();
    // An unbreakable token (ECONNREFUSED host:8443, a long path) must break
    // inside the notice rather than scroll the document sideways.
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    // Bounded height + scroll, not -webkit-line-clamp: the dock renders this
    // directly above the composer, so an unbounded reason must not push the
    // composer off a 390x844 screen, and the whole recorded cause must stay
    // reachable rather than hidden.
    // Review round 2, LOW-1: pin the VALUE, not just the property's
    // presence — an injection widening `max-height: 5.6em` to `560em` (the
    // rule still present, `overflow-y: auto` still present) passed every
    // prior assertion here while the notice grew to 2548px and pushed the
    // composer to y=2598 on an 844px viewport, the exact harm this rule
    // exists to prevent. Four lines at `line-height: 1.4`.
    expect(rule).toMatch(/line-height:\s*1\.4\b/);
    expect(rule).toMatch(/max-height:\s*5\.6em\b/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('reuses the shared secondary-button treatment instead of a bespoke duplicate', () => {
    const css = read('index.css');
    const chatDock = read('components/chat-dock/ChatDockBody.tsx');

    // The old bespoke rule matched `button:hover` on specificity and lost on
    // source order, so hover never took effect — the fix is to reuse
    // `.button.button--secondary` (already proven two rules above, at
    // `.session-history-controls__more`), not to keep styling this button
    // alone. Matches any selector combining `.session-history-error` with a
    // bare `button` element selector (descendant or child combinator, with
    // or without surrounding whitespace) — not just the one exact spelling
    // that shipped before.
    expect(css).not.toMatch(/\.session-history-error\s*>?\s*button\s*\{/);
    expect(chatDock).toContain(
      'className="button button--secondary session-history-error__retry"',
    );

    const [retryRule] = ruleBodies(css, '.session-history-error__retry');
    expect(
      retryRule,
      'missing .session-history-error__retry rule',
    ).toBeDefined();
    // Positioning only. Reintroducing color/border/background here would
    // resurrect the duplicate-specificity hazard the shared class exists to
    // avoid.
    expect(retryRule).not.toMatch(/\bcolor:/);
    expect(retryRule).not.toMatch(/\bbackground:/);
    expect(retryRule).not.toMatch(/\bborder:/);
  });

  it('places .session-history-error__retry after .button in source order, so its override actually wins', () => {
    // Review round 2, MEDIUM-1: both selectors carry (0,1,0) specificity, so
    // whichever rule is later in source order wins. This rule shipped ~1800
    // lines BEFORE `.button {}` once, which made the whole override inert —
    // `.button`'s own 10px/16px sizing rendered instead. Measured on the
    // built bundle: padding 10px/16px, font-size 14px, height 42px (45%
    // taller than intended) with the rule before `.button`; padding
    // 6px/12px, font-size 11px, height 29px with it after. This assertion is
    // the only thing pinning the ordering that decides which of those ships.
    const css = read('index.css');
    // Round 3: `css.indexOf('.button {')` is not unique — this file's own
    // comment above (and three other real rules) contain that literal
    // substring, so an injection moving this block back before the real
    // `.button {}` rule left the comment's copy of the text sitting a few
    // lines above `retryIndex` and the assertion stayed green while the
    // shipped bundle regressed to the un-overridden 10px/16px sizing.
    // The real rule sits at column 0 preceded by a blank line (`.css`
    // never nests a bare `.button {` inside another rule at this repo's
    // formatting conventions); prose only ever contains it indented, inside
    // a sentence, or inside a `` `.button {}` `` code span. Matching the
    // leading newline anchors on the actual rule, not any comment's copy.
    const buttonIndex = css.indexOf('\n.button {');
    const retryIndex = css.indexOf('.session-history-error__retry {');
    expect(buttonIndex, 'missing .button {} rule').toBeGreaterThan(-1);
    expect(
      retryIndex,
      'missing .session-history-error__retry rule',
    ).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(buttonIndex);
  });
});
