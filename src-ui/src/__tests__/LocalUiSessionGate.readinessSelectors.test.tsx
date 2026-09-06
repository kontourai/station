/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ACCESS_REQUIRED_SELECTOR,
  AUTHENTICATED_SHELL_SELECTOR,
  DEGRADED_ACCESS_ALERT,
  HOST_RECOVERY_RELOAD_CONTROL,
  HOST_RECOVERY_SCREEN_SELECTOR,
  PENDING_ACCESS_CHECK_SELECTOR,
} from '../../../tests/helpers/local-ui-access-readiness';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { DEGRADED_QUERY_TIMEOUT_MS } from '../hooks/useDegradedQueryState';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';
import { PlatformBootstrap } from '../platform/PlatformProfileContext';

/**
 * The first-run journey's readiness wait
 * (`tests/helpers/local-ui-access-readiness.ts`) decides what to do from which
 * of these selectors matches, and that decision is only as good as the mapping.
 * A Playwright helper cannot prove the mapping — it can only fail to find
 * something, 20 s later, for any reason at all. station#1617 was exactly that:
 * a gate screen the wait did not name, reported as "neither of two other things
 * appeared".
 *
 * So drive the REAL component through every resolution it has and require the
 * set to be exhaustive (each resolution matches one) and mutually exclusive
 * (never two, and never one while the gate is still working). A copy change, an
 * `aria-label` change or a dropped class reds here instead of becoming a 20 s
 * browser timeout.
 */

const SETTLED_SELECTORS = [
  AUTHENTICATED_SHELL_SELECTOR,
  ACCESS_REQUIRED_SELECTOR,
  HOST_RECOVERY_SCREEN_SELECTOR,
] as const;

/**
 * Stands in for the protected application tree, whose real `<main>` carries
 * this id (`src-ui/src/App.tsx`). The id itself is pinned separately below.
 */
function ProtectedShell() {
  return (
    <main className="main-content" id="station-main" tabIndex={-1}>
      Protected application mounted
    </main>
  );
}

function renderGate() {
  return render(
    <StrictMode>
      <PlatformBootstrap>
        <ApiBaseProvider>
          <LocalUiSessionGate apiBase="http://127.0.0.1:42693">
            <ProtectedShell />
          </LocalUiSessionGate>
        </ApiBaseProvider>
      </PlatformBootstrap>
    </StrictMode>,
  );
}

function matching(selectors: readonly string[]): string[] {
  return selectors.filter(
    (selector) => document.querySelectorAll(selector).length > 0,
  );
}

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('local UI access readiness selectors map to the gate one-to-one', () => {
  test.each([
    [
      'authenticated',
      () => new Response('{}', { status: 200 }),
      AUTHENTICATED_SHELL_SELECTOR,
    ],
    [
      'access-required',
      () => new Response('{}', { status: 401 }),
      ACCESS_REQUIRED_SELECTOR,
    ],
    [
      'host-unavailable',
      () =>
        Response.json({ ready: false, status: 'unavailable' }, { status: 503 }),
      HOST_RECOVERY_SCREEN_SELECTOR,
    ],
  ])(
    'a %s resolution matches exactly one settled selector',
    async (_resolution, answer, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer()));

      renderGate();
      await waitFor(() =>
        expect(matching(SETTLED_SELECTORS)).toEqual([expected]),
      );

      // The gate's pending output is gone once it has an answer, so the wait
      // can never read a settled screen as "still working".
      expect(matching([PENDING_ACCESS_CHECK_SELECTOR])).toEqual([]);
    },
  );

  test('the host-recovery screen offers the control the wait takes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ready: false, status: 'unavailable' },
            { status: 503 },
          ),
        ),
    );

    renderGate();
    await waitFor(() =>
      expect(
        document.querySelector(HOST_RECOVERY_SCREEN_SELECTOR),
      ).not.toBeNull(),
    );

    const recovery = document.querySelector(HOST_RECOVERY_SCREEN_SELECTOR);
    expect(recovery?.querySelector('button')?.textContent).toBe(
      HOST_RECOVERY_RELOAD_CONTROL,
    );
  });

  test('a pending gate, degraded or not, matches no settled selector', async () => {
    vi.useFakeTimers();
    try {
      // A request that never settles: the case the degraded window exists for.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValue(new Promise<Response>(() => {})),
      );

      renderGate();

      expect(matching(SETTLED_SELECTORS)).toEqual([]);
      expect(matching([PENDING_ACCESS_CHECK_SELECTOR])).toEqual([
        PENDING_ACCESS_CHECK_SELECTOR,
      ]);
      expect(document.body.textContent ?? '').not.toMatch(
        DEGRADED_ACCESS_ALERT,
      );

      await act(async () => {
        vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS);
      });

      // The degraded alert is up. It is the state the old wait FAILED on, and
      // it must still read as pending: no settled selector may match it.
      expect(document.body.textContent ?? '').toMatch(DEGRADED_ACCESS_ALERT);
      expect(matching(SETTLED_SELECTORS)).toEqual([]);
      expect(matching([PENDING_ACCESS_CHECK_SELECTOR])).toEqual([
        PENDING_ACCESS_CHECK_SELECTOR,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the protected shell selector names the element App actually renders', () => {
    // The one selector above whose subject is not the gate. Rendering the whole
    // app to assert it would cost more than it proves, so pin the source: a
    // rename here would otherwise surface only as a 20 s browser timeout.
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'),
      'utf8',
    );
    const [element, id] = AUTHENTICATED_SHELL_SELECTOR.split('#');
    expect(element).toBe('main');
    const idAttribute = `id="${id}"`;
    const at = app.indexOf(idAttribute);
    expect(at, `${idAttribute} is not in App.tsx`).toBeGreaterThan(-1);
    // The attribute must belong to a `<main>` tag: walk back to the tag it
    // opens, so `id` on some other element cannot satisfy this.
    expect(app.slice(app.lastIndexOf('<', at), at)).toMatch(
      new RegExp(`^<${element}[\\s>]`),
    );
  });
});
