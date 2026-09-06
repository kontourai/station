/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ACCESS_REQUIRED_REGION_NAME,
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
 * of these screens it can see, and that decision is only as good as the
 * mapping. A Playwright helper cannot prove the mapping — it can only fail to
 * find something, 20 s later, for any reason at all. station#1617 was exactly
 * that: a gate screen the wait did not name, reported as "neither of two other
 * things appeared".
 *
 * So drive the REAL component through every resolution it has and require the
 * set to be exhaustive (each resolution matches one) and mutually exclusive
 * (never two, and never one while the gate is still working). Each probe below
 * reads through the SAME channel the adapter resolves on — a CSS selector where
 * it uses `page.locator`, an accessible role and name where it uses
 * `getByRole` — so a change that stops the wait matching cannot leave this
 * green.
 *
 * WHAT THIS DOES NOT COVER, deliberately:
 *  - The adapter itself. `classifySettled`'s priority order, the `.or()` union,
 *    `APP_ROOT_CHILD_SELECTOR`, the platform-loader classification and the
 *    missing-control throw are verified by reading and by the live first-run
 *    suite; nothing here executes them. A Page-shaped fake would close that if
 *    it is ever worth the cost.
 *  - The shell selector's element. The pin below reads App's source, so it
 *    covers the TAG and its id, not that the element is on screen.
 *  - Visibility. These are presence checks; the adapter asks Playwright for
 *    visibility. No caller reaches a dock-owned view where that could differ
 *    (`isAmbientMobileDockFullscreen` is structurally false for the `layout`
 *    view type the one call site uses).
 *  - `section[aria-label="Station sample workspace"]`, the gate's fifth screen
 *    and `access-required`'s second: it is reachable only by clicking "Explore
 *    a sample", so no wait can arrive at it. The helper reports it as
 *    `unmodelled`, which is the right answer if one ever does.
 */

type ScreenProbe = { readonly label: string; readonly present: () => boolean };

const AUTHENTICATED_SHELL: ScreenProbe = {
  label: 'authenticated shell',
  present: () =>
    document.querySelectorAll(AUTHENTICATED_SHELL_SELECTOR).length > 0,
};
const ACCESS_REQUIRED: ScreenProbe = {
  label: 'access-required region',
  // Through the role and accessible name, as the adapter does: a `role` or
  // `aria-label` change that stops the wait matching must red here too.
  present: () =>
    screen.queryAllByRole('region', { name: ACCESS_REQUIRED_REGION_NAME })
      .length > 0,
};
const HOST_RECOVERY: ScreenProbe = {
  label: 'host-recovery screen',
  present: () =>
    document.querySelectorAll(HOST_RECOVERY_SCREEN_SELECTOR).length > 0,
};
const PENDING_ACCESS_CHECK: ScreenProbe = {
  label: 'pending access check',
  present: () =>
    document.querySelectorAll(PENDING_ACCESS_CHECK_SELECTOR).length > 0,
};

const SETTLED_PROBES = [
  AUTHENTICATED_SHELL,
  ACCESS_REQUIRED,
  HOST_RECOVERY,
] as const;

function present(probes: readonly ScreenProbe[]): string[] {
  return probes.filter((probe) => probe.present()).map((probe) => probe.label);
}

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

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('local UI access readiness screens map to the gate one-to-one', () => {
  test.each([
    [
      'authenticated',
      () => new Response('{}', { status: 200 }),
      AUTHENTICATED_SHELL.label,
    ],
    [
      'access-required',
      () => new Response('{}', { status: 401 }),
      ACCESS_REQUIRED.label,
    ],
    [
      'host-unavailable',
      () =>
        Response.json({ ready: false, status: 'unavailable' }, { status: 503 }),
      HOST_RECOVERY.label,
    ],
  ])(
    'a %s resolution matches exactly one settled screen',
    async (_resolution, answer, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer()));

      renderGate();
      await waitFor(() => expect(present(SETTLED_PROBES)).toEqual([expected]));

      // The gate's pending output is gone once it has an answer, so the wait
      // can never read a settled screen as "still working".
      expect(present([PENDING_ACCESS_CHECK])).toEqual([]);
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
    await waitFor(() => expect(HOST_RECOVERY.present()).toBe(true));

    // Scoped inside the recovery screen and read by accessible name, which is
    // how the adapter finds it — not by `textContent`, which an added
    // `aria-label` would leave intact while the wait stopped matching.
    const recovery = document.querySelector(HOST_RECOVERY_SCREEN_SELECTOR);
    expect(recovery).not.toBeNull();
    expect(
      screen.getByRole('button', { name: HOST_RECOVERY_RELOAD_CONTROL }),
    ).toBe(recovery?.querySelector('button'));
  });

  test('a pending gate, degraded or not, matches no settled screen', async () => {
    vi.useFakeTimers();
    try {
      // A request that never settles: the case the degraded window exists for.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValue(new Promise<Response>(() => {})),
      );

      renderGate();

      expect(present(SETTLED_PROBES)).toEqual([]);
      expect(present([PENDING_ACCESS_CHECK])).toEqual([
        PENDING_ACCESS_CHECK.label,
      ]);
      expect(document.body.textContent ?? '').not.toMatch(
        DEGRADED_ACCESS_ALERT,
      );

      await act(async () => {
        vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS);
      });

      // The degraded alert is up. It is the state the old wait FAILED on, and
      // it must still read as pending: no settled screen may match it.
      expect(document.body.textContent ?? '').toMatch(DEGRADED_ACCESS_ALERT);
      expect(present(SETTLED_PROBES)).toEqual([]);
      expect(present([PENDING_ACCESS_CHECK])).toEqual([
        PENDING_ACCESS_CHECK.label,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the protected shell selector names the element App actually renders', () => {
    // The one screen above whose subject is not the gate. Rendering the whole
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
