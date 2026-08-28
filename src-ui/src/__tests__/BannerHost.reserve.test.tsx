/**
 * @vitest-environment jsdom
 *
 * The banner stack stops covering content, and every banner collapses.
 *
 * Two claims, deliberately kept in one file because they are the same fix:
 * a collapsed banner is shorter, and the reserved space follows it, which is
 * the only reason collapsing does anything about overlap at all.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BANNER_RESERVED_HEIGHT_PROPERTY,
  BannerHost,
} from '../components/notifications/BannerHost';
import { bannerReservedHeight, bannerStore } from '../contexts/banner-store';

afterEach(() => {
  vi.restoreAllMocks();
  act(() => bannerStore.reset());
});

const BANNER_CSS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../components/notifications/BannerHost.css',
);

/**
 * The MOTION PRIMITIVE. The reduced-motion decision is made once, here, for
 * the whole app; `BannerHost.css` no longer restates it for its own selectors
 *The contract these tests assert is
 * therefore spread across two files, and reading only one of them would let
 * either half be deleted with a green suite.
 */
const TOKENS_CSS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../tokens.css',
);

/**
 * Comments are stripped before any of this file's CSS assertions run. Both
 * helpers below identify a rule by the text preceding its `{`, and this
 * stylesheet documents nearly every rule it declares — an un-stripped comment
 * silently makes a selector unmatchable, which reads as "the rule is missing"
 * rather than "the parser cannot see it".
 */
function readCss(): string {
  return readFileSync(BANNER_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

function readTokensCss(): string {
  return readFileSync(TOKENS_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Rule bodies for an exact selector, in source order. */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(css);
  while (match !== null) {
    if (match[1].replace(/\s+/g, ' ').trim() === selector)
      bodies.push(match[2]);
    match = pattern.exec(css);
  }
  return bodies;
}

/**
 * Bodies of every `@media (<condition>)` block, brace-balanced so a nested
 * rule cannot leak out of (or into) the block being asserted about.
 */
function mediaBlocks(css: string, condition: string): string[] {
  const blocks: string[] = [];
  const header = `@media (${condition})`;
  let from = css.indexOf(header);
  while (from !== -1) {
    const open = css.indexOf('{', from);
    let depth = 0;
    let cursor = open;
    while (cursor < css.length) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      cursor += 1;
    }
    blocks.push(css.slice(open + 1, cursor));
    from = css.indexOf(header, cursor);
  }
  return blocks;
}

/**
 * jsdom lays nothing out, so every box reads 0. Geometry is supplied per
 * element instead — the host's own top, and each card's bottom edge — which
 * is exactly the pair the reservation is derived from.
 */
function stubGeometry(
  edges: (element: Element) => [top: number, bottom: number],
) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const [top, bottom] = edges(this);
      return {
        top,
        bottom,
        left: 0,
        right: 320,
        width: 320,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

const HOST_TOP = 40;

/** Host at y=40; each card 60px tall, stacked from y=46. */
function stackedCards(element: Element): [number, number] {
  if (element.classList.contains('banner-host')) return [HOST_TOP, 0];
  const index = element.hasAttribute('data-banner-id')
    ? Number(element.getAttribute('data-index') ?? '0')
    : 0;
  const top = 46 + index * 66;
  return [top, top + 60];
}

function presentBlocking(overrides: Record<string, unknown> = {}) {
  act(() => {
    bannerStore.present({
      id: 'test:blocking',
      priority: 100,
      tone: 'blocked',
      badge: 'Credential required',
      message: 'Station cannot reach this host until you pair again.',
      detail: 'Automatic reconnect is paused until this is resolved.',
      actions: [{ label: 'Pair again', onClick: () => {} }],
      ...overrides,
    });
  });
}

describe('bannerReservedHeight', () => {
  test('reserves nothing when there is nothing to reserve for', () => {
    expect(bannerReservedHeight(40, [])).toBe(0);
  });

  test('reserves down to the bottom-most reserving edge, not the sum', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: true, bottom: 106 },
        { reserves: true, bottom: 172 },
      ]),
    ).toBe(132);
  });

  test('an overlay-only stack reserves nothing at all', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: false, bottom: 106 },
        { reserves: false, bottom: 172 },
      ]),
    ).toBe(0);
  });

  test('an overlay banner below the last reserving one adds nothing', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: true, bottom: 106 },
        { reserves: false, bottom: 172 },
      ]),
    ).toBe(66);
  });

  test('a reserving banner below an overlay one reserves through it', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: false, bottom: 106 },
        { reserves: true, bottom: 172 },
      ]),
    ).toBe(132);
  });

  test('an un-laid-out (or stale) box reserves nothing rather than a negative', () => {
    expect(bannerReservedHeight(40, [{ reserves: true, bottom: 0 }])).toBe(0);
  });
});

describe('BannerHost space reservation', () => {
  test('publishes the occupied height onto its own container', () => {
    stubGeometry(stackedCards);
    presentBlocking();
    const { container } = render(<BannerHost />);

    // Card bottom 106, host top 40.
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');
  });

  test('an overlay banner is measured and still reserves nothing', () => {
    stubGeometry(stackedCards);
    presentBlocking({ overlay: true });
    const { container } = render(<BannerHost />);

    expect(screen.getByRole('alert').getAttribute('data-overlay')).toBe('true');
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('hands the space back when the last banner leaves', () => {
    stubGeometry(stackedCards);
    presentBlocking();
    const { container } = render(<BannerHost />);
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');

    act(() => bannerStore.dismiss('test:blocking'));

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('hands the space back on unmount, not leaving the app permanently inset', () => {
    stubGeometry(stackedCards);
    presentBlocking();
    const { container, unmount } = render(<BannerHost />);
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');

    unmount();

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('the content area is inset by the published height', () => {
    const css = readCss();
    const [body] = ruleBodies(css, '.app__main > .main-content');
    expect(body, 'no rule consumes the reservation').toBeDefined();
    // On `.main-content` (the box that is NOT the scroller), so the band is
    // taken out of the scroll viewport and nothing passes behind the banner.
    expect(body).toMatch(/padding-top:\s*var\(--banner-stack-height,\s*0px\)/);
  });
});

describe('BannerHost per-banner collapse', () => {
  test('a non-dismissible blocking banner is collapsible', () => {
    presentBlocking({ dismissible: false });
    render(<BannerHost />);

    // archive#3432 kept this band out of the stack cap; that is about leaving
    // the DOM, and says nothing about collapsing in place.
    expect(screen.queryByRole('button', { name: 'Dismiss notice' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Collapse notice' }),
    ).toBeTruthy();
  });

  test('collapsing keeps the fault named and its actions reachable', () => {
    presentBlocking({ dismissible: false });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    const card = screen.getByRole('alert');
    expect(card.dataset.collapsed).toBe('true');
    expect(card.className).toMatch(/banner-host__item--collapsed/);
    // Not a blank strip: the badge, the message and the remedy all survive.
    expect(screen.getByText('Credential required')).toBeTruthy();
    expect(screen.getByText(/Station cannot reach this host/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeTruthy();
    // Only the recoverable part goes: the detail disclosure is not rendered
    // (a focusable control inside a clipped box is reachable and invisible).
    // archive#4470b: the toggle's label is the constant "Details" now (was
    // "More"/"Less").
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand notice' })).toBeTruthy();
  });

  test('a source re-presenting the same occurrence does not re-open it', () => {
    presentBlocking({ occurrence: 'pairing-required' });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });
    expect(screen.getByRole('alert').dataset.collapsed).toBe('true');

    // The poll that would otherwise undo the user's decision every 10s.
    presentBlocking({
      occurrence: 'pairing-required',
      message: 'Changed copy.',
    });

    expect(screen.getByRole('alert').dataset.collapsed).toBe('true');
  });

  test('a new occurrence of the same condition arrives expanded', () => {
    presentBlocking({ occurrence: 'pairing-required' });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });
    expect(screen.getByRole('alert').dataset.collapsed).toBe('true');

    presentBlocking({ occurrence: 'host-moved' });

    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
  });

  test('an old occurrence coming back does not resurrect the old collapse', () => {
    presentBlocking({ occurrence: 'pairing-required' });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    // Superseded by a different occurrence, which arrives expanded...
    presentBlocking({ occurrence: 'host-moved' });
    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
    //.and the first condition recurring is a new thing to read, not a
    // resumption of the showing the user collapsed. Same posture as
    // dismissal, whose suppression key is released the same way.
    presentBlocking({ occurrence: 'pairing-required' });

    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
  });

  test('clear(prefix) releases the collapsed state with the banner', () => {
    presentBlocking();
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    act(() => bannerStore.clear('test:'));
    presentBlocking();

    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
  });

  test('an exiting banner is never forced through the collapsed layout', () => {
    presentBlocking({ dismissible: true });
    const { container } = render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    act(() => bannerStore.dismiss('test:blocking', { reason: 'user' }));

    // Queried by attribute, not by role: an exiting card is `aria-hidden`.
    // Both states would drive `height`, and the exit's row collapse must win.
    const card = container.querySelector('[data-banner-id]');
    expect(card).not.toBeNull();
    if (card === null) return;
    expect(card.className).toMatch(/banner-host__item--exiting/);
    expect(card.className).not.toMatch(/banner-host__item--collapsed/);
  });
});

describe('BannerHost collapse animation contract', () => {
  test('collapse is a real height tween, behind prefers-reduced-motion', () => {
    const css = readCss();

    // The two ends of the tween: both lengths, so `height` interpolates.
    const [item] = ruleBodies(css, '.banner-host__item');
    expect(item).toMatch(/height:\s*var\(--banner-natural-height,\s*auto\)/);
    const [collapsedCard] = ruleBodies(css, '.banner-host__item--collapsed');
    expect(collapsedCard).toMatch(/height:\s*var\(--banner-collapsed-height\)/);

    // Non-zero: the collapsed card is a bar, not a blank strip.
    expect(item).toMatch(/--banner-collapsed-height:\s*(?!0px)\d+px/);

    // The tween itself. Anchored on the separator before it: unanchored, this
    // pattern also matches `min-height var(--motion-base)...` two rules down,
    // and an injection that deleted the height tween outright still read as
    // present. A regex that matches a different property is not a test.
    const tween = /[\s,]height var\(--motion-base\) var\(--ease-standard\)/;
    expect(css).toMatch(tween);

    // "behind prefers-reduced-motion" is still the contract; what changed is
    // WHERE it is derived. This file used to wrap the tween in its own
    // `no-preference` block, which is the same preference the motion primitive
    // already reads for every surface in the app — so the wrapper was a second
    // copy of a decision, and the DRY rule retired it. The refusal now comes
    // from `tokens.css`, asserted here rather than assumed: a universal rule,
    // inside a `reduce` block, forcing transition AND animation duration to a
    // near-zero value with `!important` (so it wins over this file's
    // unconditional declaration regardless of order or specificity).
    const [primitiveReduce] = mediaBlocks(
      readTokensCss(),
      'prefers-reduced-motion: reduce',
    );
    expect(primitiveReduce).toBeDefined();
    expect(primitiveReduce).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(primitiveReduce).toMatch(
      /transition-duration:\s*0(?:\.\d+)?m?s\s*!important/,
    );
    expect(primitiveReduce).toMatch(
      /animation-duration:\s*0(?:\.\d+)?m?s\s*!important/,
    );
  });

  test('reduced motion refuses the tween but keeps the inset correct', () => {
    const css = readCss();
    // The inset TRANSITION is refused by the motion primitive (asserted in the
    // test above), so this file no longer carries a `transition: none` copy of
    // that decision. What it must never do is touch the inset ITSELF: the
    // content area still has to be inset under reduced motion — only the move
    // into place is refused. An inset that reduced motion switched OFF would
    // put the overlap straight back for exactly the users who asked for less
    // motion. So: the tween is declared, and NO reduced-motion rule anywhere
    // in this file alters `padding-top`.
    expect(css).toMatch(
      /\.app__main > \.main-content \{\s*transition: padding-top/,
    );
    for (const reduce of mediaBlocks(css, 'prefers-reduced-motion: reduce')) {
      expect(reduce).not.toMatch(/padding-top/);
    }
  });
});
