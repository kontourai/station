/**
 * Cross-Station settlement scoping against the REAL SDK transport
 * (kontourai/station#1418, #1419 review round 2, HIGH). The rest of this
 * suite (`plugin-command-effect-coordinator.test.ts`) scripts a fake
 * transport; this file wires the coordinator to the actual
 * `admitPluginCommandEffect`/`settlePluginCommandEffects` fetchers and a real
 * `setClientCredentialResolver`, because the defect lives in how
 * `mutateJson` resolves a credential for a stale `apiBase` — a fake
 * transport cannot see it.
 */
import type { PluginCommandEffectContent } from '@kontourai/station-contracts/plugin-command-effect';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  admitPluginCommandEffect,
  settlePluginCommandEffects,
} from '@kontourai/station-sdk/client/plugin-command-effects';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createPluginCommandEffectCoordinator,
  type PluginCommandEffectRunInput,
  type PluginCommandEffectStorageLike,
  type PluginCommandEffectTransport,
  type PluginCommandEffectWindowLike,
} from '../plugin-command-effect-coordinator';

// Mirrors `PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX_AGE_MS` as a literal
// so this file keeps working (and keeps discriminating) even when run
// against a coordinator build that predates that export.
const RETAINED_SETTLEMENT_MAX_AGE_MS = 10 * 60 * 1000;

const STATION_A = 'https://station-a.test';
const STATION_B = 'https://station-b.test';

function fakeStorage(): PluginCommandEffectStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

type Lifecycle = 'pagehide' | 'pageshow';
function fakeWindow(): PluginCommandEffectWindowLike {
  const listeners = new Map<Lifecycle, Set<(event: never) => void>>();
  return {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as never);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener as never);
    },
  };
}

function baseInput(
  overrides: Partial<PluginCommandEffectRunInput> = {},
): PluginCommandEffectRunInput {
  return {
    apiBase: STATION_A,
    pluginId: 'demo',
    commandId: 'demo.command',
    installationGeneration: 'gen-1',
    target: { kind: 'destination', destinationId: 'plugins' },
    currentGeneration: () => 'gen-1',
    apply: () => true,
    ...overrides,
  };
}

describe('plugin command effect coordinator (real SDK transport, cross-Station)', () => {
  let activeStation: 'a' | 'b' = 'a';

  beforeEach(() => {
    vi.useFakeTimers();
    activeStation = 'a';
    setClientCredentialResolver(() => {
      const isA = activeStation === 'a';
      return {
        origin: isA ? STATION_A : STATION_B,
        credential: isA ? 'token-a' : 'token-b',
        requestAuthority: {
          apiBase: isA ? STATION_A : STATION_B,
          authorityKey: isA ? 'conn-a:1' : 'conn-b:1',
          isCurrent: () =>
            isA ? activeStation === 'a' : activeStation === 'b',
        },
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  test('a decided settlement retained across a Station switch is always scoped to the OLD Station and is eventually dropped, never sent unauthenticated forever', async () => {
    const settleAttempts: Array<{
      apiBase: string;
      requestScope: unknown;
    }> = [];
    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = typeof input === 'string' ? input : String(input);
        const headers = new Headers(init?.headers);
        if (url === `${STATION_A}/api/plugins/demo/command-effects`) {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            requestId: string;
          };
          const content: PluginCommandEffectContent = {
            kind: 'navigate',
            destinationId: 'plugins',
          };
          return new Response(
            JSON.stringify({
              success: true,
              receipt: {
                effectId: 'effect-1',
                requestId: body.requestId,
                pluginId: 'demo',
                commandId: 'demo.command',
                installationGeneration: 'gen-1',
                effect: content,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === `${STATION_A}/api/plugins/command-effects/settlements`) {
          // A real server rejects this: station A's credential is no longer
          // this document's active one.
          if (headers.get('Authorization') !== 'Bearer token-a') {
            return new Response(JSON.stringify({ success: false }), {
              status: 401,
            });
          }
          return new Response(
            JSON.stringify({
              success: true,
              results: [{ requestId: 'unused', status: 'settled' }],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch to ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport: PluginCommandEffectTransport = {
      admit: (apiBase, pluginId, request, signal) =>
        admitPluginCommandEffect(apiBase, pluginId, request, { signal }),
      settle: (apiBase, request, options) => {
        settleAttempts.push({ apiBase, requestScope: options.requestScope });
        return settlePluginCommandEffects(apiBase, request, options);
      },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    coordinator.runCommand(
      baseInput({
        apply,
        requestScope: { apiBase: STATION_A, authorityKey: 'conn-a:1' },
      }),
    );
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([call]) =>
          String(call).endsWith('/command-effects'),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    // Switch Stations BEFORE the decided-but-unacked record ever gets a
    // chance to settle under the old identity.
    activeStation = 'b';
    coordinator.resetForAuthorityChange();
    expect(coordinator._debug.retainedSettlementCount).toBe(1);

    // Drive several post-switch retry cycles.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settleAttempts.length).toBeGreaterThanOrEqual(3);
    // Every attempt stays scoped to the OLD Station — never silently
    // re-attributed to the new one.
    for (const attempt of settleAttempts) {
      expect(attempt.apiBase).toBe(STATION_A);
      expect(attempt.requestScope).toEqual({
        apiBase: STATION_A,
        authorityKey: 'conn-a:1',
      });
    }
    // And whatever DID reach the network was never unauthenticated.
    for (const [input, init] of fetchMock.mock.calls) {
      const url = typeof input === 'string' ? input : String(input);
      if (!url.endsWith('/command-effects/settlements')) continue;
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer token-a',
      );
    }
    expect(coordinator._debug.retainedSettlementCount).toBe(1);

    // Advance past the retention bound: the record must be dropped rather
    // than retried forever (it can never authenticate while Station B is
    // active).
    await vi.advanceTimersByTimeAsync(RETAINED_SETTLEMENT_MAX_AGE_MS);
    expect(coordinator._debug.retainedSettlementCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('effect-1'));
  });
});
