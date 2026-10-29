/**
 * @vitest-environment node
 *
 * archive#3427. Nothing in this repo's test suite rendered
 * `ChatDockBody`'s history-failure notice before this file, so a
 * fault injection that deleted the whole
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
    // Pin the VALUE, not just the property's
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
});
