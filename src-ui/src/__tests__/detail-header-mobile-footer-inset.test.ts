/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  installVisualViewportInset,
  VISUAL_VIEWPORT_BOTTOM_INSET_VAR,
} from '../hooks/useMobileVisualViewport';

const css = readFileSync(
  join(__dirname, '..', 'components', 'DetailHeader.css'),
  'utf8',
);

/**
 * sol review, MEDIUM: the sticky mobile Save bar offset itself by the chat
 * dock's height and the safe-area inset, but not by the VISIBLE viewport's
 * bottom inset — the number the dock itself re-anchors to when the software
 * keyboard opens. The dock published that inset onto its own element, where a
 * sibling could not read it, so with an editor input focused the dock rose
 * above the keyboard and Save stayed behind it.
 */
/**
 * The LAST rule for `selector` — the phone one. `.detail-header__mobile-footer`
 * is declared twice: `display: none` at desktop, then positioned inside the
 * mobile block. Reading the first match asserts against the wrong rule and
 * passes for the wrong reason.
 */
function mobileRuleBody(selector: string): string {
  const index = css.lastIndexOf(`${selector} {`);
  expect(index, `${selector} not found`).toBeGreaterThan(-1);
  return css.slice(index, css.indexOf('}', index));
}

/** The last declaration of a custom property, likewise. */
function declaration(name: string): string {
  const index = css.lastIndexOf(`${name}:`);
  expect(index, `${name} not found`).toBeGreaterThan(-1);
  return css.slice(index, css.indexOf(';', index));
}

/**
 * station#3902 folded the three terms this file used to read here into one
 * shell-owned token, `--dock-bottom-clearance` (index.css) — because the SHELL
 * was reserving a strictly smaller number than this bar offset itself by, and
 * a route that reserved nothing of its own sat under the dock. The property
 * these tests exist for is unchanged, so they follow the derivation to where
 * it lives now rather than re-pinning the terms in two places.
 */
const indexCss = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

function dockClearance(): string {
  const index = indexCss.indexOf('--dock-bottom-clearance:');
  expect(index, '--dock-bottom-clearance not found').toBeGreaterThan(-1);
  return indexCss.slice(index, indexCss.indexOf(';', index));
}

describe('the mobile Save bar tracks the visible viewport', () => {
  test('its bottom offset includes the shared inset, alongside the dock and safe area', () => {
    expect(mobileRuleBody('.detail-header__mobile-footer')).toContain(
      'var(--dock-bottom-clearance)',
    );
    const clearance = dockClearance();
    expect(clearance).toContain('--dock-slot-size');
    expect(clearance).toContain('--safe-bottom');
    expect(clearance).toContain(VISUAL_VIEWPORT_BOTTOM_INSET_VAR);
  });

  test('and so does the clearance a scrolling body reserves for it', () => {
    expect(declaration('--detail-body-bottom-clearance')).toContain(
      'var(--dock-bottom-clearance)',
    );
    expect(dockClearance()).toContain(VISUAL_VIEWPORT_BOTTOM_INSET_VAR);
  });
});

describe('installVisualViewportInset', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(
      VISUAL_VIEWPORT_BOTTOM_INSET_VAR,
    );
    vi.unstubAllGlobals();
  });

  /** A window whose visible viewport ends `inset` px above the layout bottom. */
  function windowWith(inset: number) {
    const listeners = new Map<string, Set<() => void>>();
    const on = (type: string, listener: () => void) => {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    };
    const off = (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    };
    const target = {
      innerHeight: 844,
      document,
      visualViewport: {
        height: 844 - inset,
        offsetTop: 0,
        addEventListener: on,
        removeEventListener: off,
      },
      addEventListener: on,
      removeEventListener: off,
      // Synchronous, so the assertion reads a settled value.
      requestAnimationFrame: (callback: () => void) => {
        callback();
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      listeners,
    };
    return target as unknown as Window & { listeners: typeof listeners };
  }

  test('publishes the inset on the document element, where any surface can read it', () => {
    const target = windowWith(320);
    const dispose = installVisualViewportInset(target);
    expect(
      document.documentElement.style.getPropertyValue(
        VISUAL_VIEWPORT_BOTTOM_INSET_VAR,
      ),
    ).toBe('320px');
    dispose();
  });

  test('republishes when the viewport changes, and stops when disposed', () => {
    const target = windowWith(0);
    const dispose = installVisualViewportInset(target);
    expect(
      document.documentElement.style.getPropertyValue(
        VISUAL_VIEWPORT_BOTTOM_INSET_VAR,
      ),
    ).toBe('0px');

    (
      target as never as { visualViewport: { height: number } }
    ).visualViewport.height = 500;
    for (const listener of target.listeners.get('resize') ?? []) listener();
    expect(
      document.documentElement.style.getPropertyValue(
        VISUAL_VIEWPORT_BOTTOM_INSET_VAR,
      ),
    ).toBe('344px');

    dispose();
    (
      target as never as { visualViewport: { height: number } }
    ).visualViewport.height = 844;
    for (const listener of target.listeners.get('resize') ?? []) listener();
    expect(
      document.documentElement.style.getPropertyValue(
        VISUAL_VIEWPORT_BOTTOM_INSET_VAR,
      ),
    ).toBe('344px');
  });
});
