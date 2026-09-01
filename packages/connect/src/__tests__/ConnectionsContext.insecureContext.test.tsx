/**
 * station#1137 — `crypto.randomUUID()` is `undefined` (not throwing) in an
 * insecure context: any `http://` origin other than `localhost`/`127.0.0.1`.
 * Station listens on `0.0.0.0` by default and ships `--allowed-origin`
 * precisely so a non-localhost origin can reach it (a phone on the LAN, a
 * `.local` hostname), so this is a real user path, not a theoretical one.
 *
 * `ConnectionsProvider`'s `activation` `useRef` initializer used to call
 * `crypto.randomUUID()` unguarded. A `useRef` initializer runs during
 * render, so on an insecure origin the very first render threw
 * `TypeError: crypto.randomUUID is not a function` and the whole provider —
 * and everything under it — never mounted. That is the reported white
 * screen.
 *
 * This proves the fix by simulating the insecure-context condition
 * directly — deleting `crypto.randomUUID` before rendering — rather than by
 * navigating to a real non-localhost origin. Revert
 * `randomCorrelationId()`'s adoption in `ConnectionsContext.tsx` back to a
 * bare `crypto.randomUUID()` call and this test fails with the exact
 * production `TypeError`.
 */
// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import {
  ConnectionsProvider,
  useConnections,
} from '../react/ConnectionsContext';

function memoryAdapter(): StorageAdapter {
  const s: Record<string, string> = {};
  return {
    get: (k) => s[k] ?? null,
    set: (k, v) => {
      s[k] = v;
    },
    remove: (k) => {
      delete s[k];
    },
  };
}

let originalRandomUUID: Crypto['randomUUID'] | undefined;

afterEach(() => {
  if (originalRandomUUID) {
    globalThis.crypto.randomUUID = originalRandomUUID;
    originalRandomUUID = undefined;
  }
});

function Probe() {
  const { connections, apiBase } = useConnections();
  return (
    <div data-testid="probe">
      {connections.length}:{apiBase}
    </div>
  );
}

describe('ConnectionsProvider on an insecure (non-localhost, plain HTTP) origin', () => {
  it('mounts without throwing when crypto.randomUUID is undefined', () => {
    originalRandomUUID = globalThis.crypto.randomUUID;
    // Simulates the real condition: on `http://192.168.1.50:3141` (or any
    // non-localhost plain-HTTP origin) `Crypto.randomUUID` is absent per the
    // Web Crypto secure-context requirement — not merely throwing.
    // @ts-expect-error deliberately deleting a required method to simulate
    // an insecure context.
    delete globalThis.crypto.randomUUID;

    const store = new ConnectionStore({ storage: memoryAdapter() });

    expect(() =>
      render(
        <ConnectionsProvider
          store={store}
          defaultUrl="http://192.168.1.50:3141"
        >
          <Probe />
        </ConnectionsProvider>,
      ),
    ).not.toThrow();
  });

  it('still produces a usable, string activation id with randomUUID absent', () => {
    originalRandomUUID = globalThis.crypto.randomUUID;
    // @ts-expect-error deliberately deleting a required method to simulate
    // an insecure context.
    delete globalThis.crypto.randomUUID;

    const store = new ConnectionStore({ storage: memoryAdapter() });
    const { getByTestId } = render(
      <ConnectionsProvider store={store} defaultUrl="http://192.168.1.50:3141">
        <Probe />
      </ConnectionsProvider>,
    );

    expect(getByTestId('probe').textContent).toBe('0:http://192.168.1.50:3141');
  });
});
