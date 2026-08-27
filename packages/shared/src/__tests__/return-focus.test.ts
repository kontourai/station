/**
 * @vitest-environment jsdom
 */

/**
 * station#1206 — the two implementation gaps in the #1187 focus fallback,
 * proven against the shared module directly.
 *
 * COVERAGE HONESTY. jsdom performs no layout and its `HTMLElement.focus()`
 * succeeds on a `display: none` node, so the *authoritative* half of the gap-2
 * fix — "did the node actually take focus?" — cannot be exercised here. What
 * these tests cover is the structural `isFocusCandidate` veto, which is real
 * behaviour but not the whole guard. The browser-level half lives in
 * `tests/dialog-return-focus.spec.ts`, which runs this same module inside
 * Chromium where `.focus()` on a hidden node is the no-op that produced
 * station#1126's `activeElement = BODY` in the first place.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { applyReturnFocus, captureReturnFocus } from '../return-focus';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('captureReturnFocus', () => {
  test('captures the trigger and every ancestor below <body>', () => {
    const root = mount(`
      <main id="main"><section id="section"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );

    expect(chain.map((node) => node.id)).toEqual([
      'trigger',
      'row',
      'section',
      'main',
    ]);
    expect(chain).not.toContain(document.body);
  });

  test('falls back to document.activeElement when no target is given', () => {
    const root = mount(
      '<div><button id="here" type="button">Here</button></div>',
    );
    const button = root.querySelector<HTMLElement>('#here')!;
    button.focus();

    expect(captureReturnFocus()[0]).toBe(button);
  });
});

describe('applyReturnFocus — gap 1: never override another actor', () => {
  test('leaves focus alone when something else already claimed it', () => {
    const root = mount(`
      <main id="main"><section id="section"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
      <div role="dialog"><input id="followup" /></div>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    // The dialog's own action removed the row the trigger lived on, and opened
    // a follow-up dialog which autofocused its input in the same frame.
    document.querySelector('#row')!.remove();
    const followup = document.querySelector<HTMLElement>('#followup')!;
    followup.focus();

    applyReturnFocus(chain);

    expect(document.activeElement).toBe(followup);
    // Nor may it leave the tell-tale attribute on the container behind the
    // still-open dialog: that node is not supposed to be touched at all.
    expect(document.querySelector('#section')!.hasAttribute('tabindex')).toBe(
      false,
    );
  });

  test('still restores when focus sits on <body> — nobody else claimed it', () => {
    const root = mount(`
      <main id="main"><section id="section"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    document.querySelector('#row')!.remove();
    (document.activeElement as HTMLElement | null)?.blur();

    applyReturnFocus(chain);

    expect(document.activeElement).toBe(document.querySelector('#section'));
  });

  test('focus still inside the closing surface is our own teardown, not another actor', () => {
    const root = mount(`
      <main id="main"><div id="row">
        <button id="trigger" type="button">Open</button>
      </div></main>
      <div id="panel" role="dialog"><button id="cancel" type="button">Cancel</button></div>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    const surface = document.querySelector<HTMLElement>('#panel')!;
    document.querySelector<HTMLElement>('#cancel')!.focus();

    applyReturnFocus(chain, surface);

    expect(document.activeElement).toBe(document.querySelector('#trigger'));
  });
});

describe('applyReturnFocus — gap 2: isConnected is not "can take focus"', () => {
  test('walks past a collapsed survivor to the next link in the chain', () => {
    const root = mount(`
      <main id="main"><section id="section"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    // Deleting the last row of a section that then collapses: the section is
    // still connected, so the old `chain.find(n => n.isConnected)` stopped on
    // it — writing a tabindex onto a hidden node and calling a `.focus()` that
    // a real browser ignores.
    document.querySelector('#row')!.remove();
    const section = document.querySelector<HTMLElement>('#section')!;
    section.style.display = 'none';

    applyReturnFocus(chain);

    expect(document.activeElement).toBe(document.querySelector('#main'));
    expect(section.hasAttribute('tabindex')).toBe(false);
  });

  test('walks past a visibility:hidden survivor', () => {
    const root = mount(`
      <main id="main"><section id="section"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    document.querySelector('#row')!.remove();
    const section = document.querySelector<HTMLElement>('#section')!;
    section.style.visibility = 'hidden';

    applyReturnFocus(chain);

    expect(document.activeElement).toBe(document.querySelector('#main'));
  });

  test('walks past a [hidden] survivor', () => {
    const root = mount(`
      <main id="main"><section id="section" hidden><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    document.querySelector('#row')!.remove();

    applyReturnFocus(chain);

    expect(document.activeElement).toBe(document.querySelector('#main'));
  });

  test('does nothing at all when no link in the chain can take focus', () => {
    const root = mount(`
      <main id="main" style="display:none"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    document.querySelector('#row')!.remove();
    (document.activeElement as HTMLElement | null)?.blur();

    applyReturnFocus(chain);

    expect(document.querySelector('#main')!.hasAttribute('tabindex')).toBe(
      false,
    );
  });
});

describe('applyReturnFocus — the tabindex it writes', () => {
  test('marks a container programmatically focusable but never tabbable', () => {
    const root = mount(`
      <main id="main"><section id="section"><div id="row">
        <button id="trigger" type="button">Delete</button>
      </div></section></main>
    `);
    const chain = captureReturnFocus(
      root.querySelector<HTMLElement>('#trigger'),
    );
    document.querySelector('#row')!.remove();

    applyReturnFocus(chain);

    const section = document.querySelector<HTMLElement>('#section')!;
    expect(document.activeElement).toBe(section);
    expect(section.getAttribute('tabindex')).toBe('-1');
  });

  test('leaves a natively focusable trigger untouched', () => {
    const root = mount(`
      <main id="main"><button id="trigger" type="button">Open</button></main>
    `);
    const trigger = root.querySelector<HTMLElement>('#trigger')!;
    const chain = captureReturnFocus(trigger);

    applyReturnFocus(chain);

    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('tabindex')).toBe(false);
  });
});
