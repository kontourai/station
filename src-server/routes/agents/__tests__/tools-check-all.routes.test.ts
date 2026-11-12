/**
 * Check all (`POST /integrations/check-all`): one server batch. It probes
 * every configured tool server Station does not run itself, at most three at
 * a time and without beginning a sign-in; a request that arrives while one
 * runs joins it; and the Agents reload at most once, only when a probe
 * changed what a server offers.
 */
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { checkAllToolServers, createToolRoutes } from '../tools.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const passed = (toolNames: string[]) => ({
  ok: true,
  toolCount: toolNames.length,
  toolNames,
  checkedAt: '2026-11-01T00:00:00.000Z',
});

function harness(servers: ToolDef[], outcomes: Record<string, ToolDef>) {
  let inFlight = 0;
  let peak = 0;
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const probeIntegration = vi.fn(async (id: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const gate = deferred<void>();
    gates.set(id, gate);
    await gate.promise;
    inFlight -= 1;
    const outcome = outcomes[id];
    if (!outcome) throw new Error(`probe of ${id} failed to start`);
    return outcome;
  });
  const service = {
    listIntegrations: vi.fn(async () => servers),
    probeIntegration,
  };
  const reinitialize = vi.fn(async () => {});
  const app = createToolRoutes(service as never, reinitialize);
  /** Lets each probe finish as it starts, until `pending` settles. */
  const settle = async <T>(response: T | Promise<T>): Promise<T> => {
    const pending = Promise.resolve(response);
    let done = false;
    pending.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const [id, gate] of [...gates]) {
        gates.delete(id);
        gate.resolve();
      }
    }
    return pending;
  };
  return {
    app,
    probeIntegration,
    reinitialize,
    settle,
    peak: () => peak,
    waiting: () => gates.size,
  };
}

const remote = (id: string, extra: Partial<ToolDef> = {}): ToolDef => ({
  id,
  kind: 'mcp',
  transport: 'streamable-http',
  endpoint: `https://${id}.example/mcp`,
  probe: passed(['read']),
  ...extra,
});

describe('POST /check-all', () => {
  test('probes servers three at a time without starting a sign-in, skips built-in, off and per-person servers, and reports each', async () => {
    const servers = [
      remote('a'),
      remote('b'),
      remote('c'),
      remote('d'),
      remote('e'),
      remote('station-control'),
      remote('off', { enabled: false }),
      remote('mine', {
        credentialOwnership: { mode: 'per-principal' } as never,
      }),
    ];
    const h = harness(servers, {
      a: remote('a'),
      b: remote('b'),
      c: remote('c', {
        probe: {
          ok: false,
          toolCount: 0,
          checkedAt: 'now',
          authorization: { state: 'never-authorized' },
        },
      }),
      d: remote('d', {
        probe: { ok: false, toolCount: 0, checkedAt: 'now', error: 'down' },
      }),
    });
    const response = h.app.request('/check-all', { method: 'POST' });
    await vi.waitFor(() => expect(h.waiting()).toBe(3));
    expect(h.peak()).toBe(3);
    const body = await json(await h.settle(response));
    expect(h.peak()).toBe(3);
    expect(h.probeIntegration.mock.calls).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((id) => [
        id,
        undefined,
        { startSignIn: false },
      ]),
    );
    expect(body.data.results).toEqual([
      { id: 'a', outcome: 'ready' },
      { id: 'b', outcome: 'ready' },
      { id: 'c', outcome: 'sign-in-required' },
      { id: 'd', outcome: 'failed', error: 'down' },
      { id: 'e', outcome: 'failed', error: 'probe of e failed to start' },
      { id: 'mine', outcome: 'skipped' },
    ]);
    // c and d stopped passing: one reload for the whole batch.
    expect(h.reinitialize).toHaveBeenCalledTimes(1);
    expect(body.data.reloaded).toBe(true);
  });

  test('does not reload when no probe changed what a server offers', async () => {
    const h = harness([remote('a'), remote('b')], {
      a: remote('a'),
      b: remote('b'),
    });
    const response = h.app.request('/check-all', { method: 'POST' });
    expect((await json(await h.settle(response))).data.reloaded).toBe(false);
    expect(h.reinitialize).not.toHaveBeenCalled();
  });

  test('a second request while a batch runs joins it rather than starting another', async () => {
    const h = harness([remote('a')], {
      a: remote('a', { probe: passed(['read', 'write']) }),
    });
    const first = h.app.request('/check-all', { method: 'POST' });
    await vi.waitFor(() => expect(h.waiting()).toBe(1));
    const second = h.app.request('/check-all', { method: 'POST' });
    const [one, two] = await Promise.all([
      json(await h.settle(first)),
      json(await second),
    ]);
    expect(two).toEqual(one);
    expect(h.probeIntegration).toHaveBeenCalledTimes(1);
    expect(h.reinitialize).toHaveBeenCalledTimes(1);
    // Once it has finished, a new request runs a new batch.
    await h.settle(h.app.request('/check-all', { method: 'POST' }));
    expect(h.probeIntegration).toHaveBeenCalledTimes(2);
  });
  test('reloads when a tool changes its description or input schema under the same name', async () => {
    const before = { ...passed(['read']), toolsDigest: 'digest-a' };
    const after = { ...passed(['read']), toolsDigest: 'digest-b' };
    const h = harness([remote('a', { probe: before })], {
      a: remote('a', { probe: after }),
    });
    const response = h.app.request('/check-all', { method: 'POST' });
    expect((await json(await h.settle(response))).data.reloaded).toBe(true);
    expect(h.reinitialize).toHaveBeenCalledTimes(1);
  });

  test('reloads when only the tool count changes', async () => {
    const h = harness([remote('a', { probe: passed(['read']) })], {
      a: remote('a', { probe: { ...passed(['read']), toolCount: 2 } }),
    });
    const response = h.app.request('/check-all', { method: 'POST' });
    expect((await json(await h.settle(response))).data.reloaded).toBe(true);
  });

  test('a server whose probe is never saved compares with its previous batch, not with nothing', async () => {
    // A package-supplied server: the listing never carries its probe.
    const listed = remote('pkg', { probe: undefined });
    const h = harness([listed], {
      pkg: remote('pkg', {
        probe: { ...passed(['read']), toolsDigest: 'same' },
      }),
    });
    const first = h.app.request('/check-all', { method: 'POST' });
    expect((await json(await h.settle(first))).data.reloaded).toBe(true);
    const second = h.app.request('/check-all', { method: 'POST' });
    expect((await json(await h.settle(second))).data.reloaded).toBe(false);
    expect(h.reinitialize).toHaveBeenCalledTimes(1);
  });
});

describe('checkAllToolServers deadlines', () => {
  const hung = () => new Promise<ToolDef>(() => {});

  test('a probe that outlives its timeout reports timed out and the batch still finishes', async () => {
    const probeIntegration = vi.fn(async (id: string) =>
      id === 'slow' ? hung() : remote(id),
    );
    const reinitialize = vi.fn(async () => {});
    const result = await checkAllToolServers(
      {
        listIntegrations: vi.fn(async () => [remote('slow'), remote('fast')]),
        probeIntegration,
      } as never,
      reinitialize,
      new Map(),
      { probeTimeoutMs: 20 },
    );
    expect(result.results).toEqual([
      {
        id: 'slow',
        outcome: 'failed',
        error: 'The check timed out before the tool server answered.',
      },
      { id: 'fast', outcome: 'ready' },
    ]);
    // A timed-out probe records nothing, so it changes nothing.
    expect(result.reloaded).toBe(false);
  });

  test('servers that would start after the batch deadline are not probed', async () => {
    const probeIntegration = vi.fn(hung);
    const servers = ['a', 'b', 'c', 'd', 'e'].map((id) => remote(id));
    const result = await checkAllToolServers(
      {
        listIntegrations: vi.fn(async () => servers),
        probeIntegration,
      } as never,
      vi.fn(async () => {}),
      new Map(),
      { probeTimeoutMs: 60_000, deadlineMs: 30 },
    );
    // The first three run until the deadline; the rest never start.
    expect(probeIntegration).toHaveBeenCalledTimes(3);
    expect(result.results.map((entry) => entry.outcome)).toEqual(
      Array(5).fill('failed'),
    );
  });
});
