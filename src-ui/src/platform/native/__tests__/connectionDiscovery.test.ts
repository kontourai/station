// @vitest-environment jsdom
import { discoverConnectionCandidates } from '@kontourai/station-connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNativeConnectionDiscovery } from '../connectionDiscovery';

const invoke = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
vi.mock('../tauriInvoke', () => ({
  invokeTauri: (command: string, args: unknown) =>
    command.endsWith('|prepare') ? prepare() : invoke(command, args),
}));
let unregister: (() => void) | undefined;
beforeEach(() => {
  invoke.mockReset();
  prepare.mockReset().mockResolvedValue({ status: 'ready' });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  unregister = registerNativeConnectionDiscovery();
});
afterEach(() => {
  unregister?.();
});

const station = {
  name: 'Office Station',
  host: '192.168.1.23',
  port: 19441,
  transport: 'http',
};

describe('native LAN provider', () => {
  it.each(['permission-required', 'permission-denied', 'unavailable'])(
    'does not begin a scan when admission returns %s',
    async (status) => {
      prepare.mockResolvedValue({ status });
      invoke.mockResolvedValue({ status: 'available', candidates: [station] });
      const result = await discoverConnectionCandidates();
      expect(result.providers[0].status).toBe(status);
      expect(result.candidates).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each(['aborted', 'hidden'])(
    'does not start browsing when its owner becomes %s during permission UI',
    async (state) => {
      let finish: ((value: unknown) => void) | undefined;
      prepare.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      invoke.mockResolvedValue({ status: 'available', candidates: [station] });
      const owner = new AbortController();
      const result = discoverConnectionCandidates({ signal: owner.signal });
      if (state === 'aborted') owner.abort();
      else
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'hidden',
        });
      finish?.({ status: 'ready' });
      expect((await result).candidates).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('uses resolved host and actual port while rejecting non-LAN and malformed results', async () => {
    invoke.mockResolvedValue({
      status: 'available',
      candidates: [
        station,
        { ...station, port: 80 },
        { ...station, host: '127.0.0.1' },
        { ...station, host: '8.8.8.8' },
        { ...station, port: 65536 },
        { ...station, transport: 'file' },
      ],
    });
    const result = await discoverConnectionCandidates();
    expect(result.candidates.map((candidate) => candidate.url).sort()).toEqual([
      'http://192.168.1.23',
      'http://192.168.1.23:19441',
    ]);
    expect(invoke.mock.calls[0][0]).toBe('plugin:station-discovery|discover');
  });

  it.each([
    'permission-required',
    'permission-denied',
    'unavailable',
    'timed-out',
    'cancelled',
    'empty',
  ] as const)('preserves the native %s outcome', async (status) => {
    invoke.mockResolvedValue({ status, candidates: [] });
    const result = await discoverConnectionCandidates();
    expect(result.providers).toEqual([
      { providerId: 'native.lan-dns-sd', status },
    ]);
    expect(result.candidates).toEqual([]);
  });

  it('cancels the exact native scan on timeout and ignores its late result', async () => {
    let finish: ((value: unknown) => void) | undefined;
    invoke.mockImplementation((command) =>
      command.endsWith('|discover')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
    );
    const result = await discoverConnectionCandidates({ timeoutMs: 5 });
    const scan = invoke.mock.calls.find(([command]) =>
      command.endsWith('|discover'),
    );
    expect(invoke).toHaveBeenCalledWith(
      'plugin:station-discovery|cancel',
      scan?.[1],
    );
    expect(result.providers[0].status).toBe('timed-out');
    finish?.({ status: 'available', candidates: [station] });
    await Promise.resolve();
    expect(result.candidates).toEqual([]);
  });

  it('cancels foreground work when the app becomes hidden', async () => {
    let finish: ((value: unknown) => void) | undefined;
    invoke.mockImplementation((command) =>
      command.endsWith('|discover')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
    );
    const result = discoverConnectionCandidates();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'plugin:station-discovery|discover',
        expect.objectContaining({ scanId: expect.any(String) }),
      ),
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(
      invoke.mock.calls.some(([command]) => command.endsWith('|cancel')),
    ).toBe(true);
    finish?.({ status: 'available', candidates: [station] });
    expect((await result).providers[0].status).toBe('cancelled');
  });
});
