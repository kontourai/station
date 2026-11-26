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
    'https://office.tail123.ts.net',
    'https://station.example.com',
    'https://station.example.com:8443',
    `https://${[...Array(3).fill('a'.repeat(60)), 'b'.repeat(50), 'com'].join(
      '.',
    )}`,
  ])(
    'prefers the canonical HTTPS app-origin hint %s over the LAN URL',
    async (appOrigin) => {
      invoke.mockResolvedValue({
        status: 'available',
        candidates: [{ ...station, appOrigin }],
      });
      const result = await discoverConnectionCandidates();
      expect(result.candidates.map((candidate) => candidate.url)).toEqual([
        appOrigin,
      ]);
    },
  );

  it.each([
    undefined,
    null,
    42,
    '',
    'http://station.example.com',
    'https://user:secret@station.example.com',
    'https://station.example.com/',
    'https://station.example.com/path',
    'https://station.example.com?query=1',
    'https://station.example.com#fragment',
    'https://station.example.com:443',
    'https://STATION.example.com',
    ' https://station.example.com',
    'https://station.example.com\n',
    'https://127.0.0.1',
    'https://192.168.1.23',
    'https://[fd00::1]',
    'https://localhost',
    'https://station.example.com.',
    'https://station_name.example.com',
    'https://-station.example.com',
    `https://${'a'.repeat(64)}.example.com`,
    `https://${[...Array(3).fill('a'.repeat(60)), 'b'.repeat(51), 'com'].join(
      '.',
    )}`,
  ])(
    'falls back to the resolved LAN URL for invalid app-origin hint %j',
    async (appOrigin) => {
      invoke.mockResolvedValue({
        status: 'available',
        candidates: [{ ...station, appOrigin }],
      });
      const result = await discoverConnectionCandidates();
      expect(result.candidates.map((candidate) => candidate.url)).toEqual([
        'http://192.168.1.23:19441',
      ]);
    },
  );

  it('requires a valid resolved LAN endpoint even with an HTTPS app-origin hint', async () => {
    const appOrigin = 'https://office.tail123.ts.net';
    invoke.mockResolvedValue({
      status: 'available',
      candidates: [
        { ...station, appOrigin, host: '127.0.0.1' },
        { ...station, appOrigin, host: '8.8.8.8' },
        { ...station, appOrigin, host: 'office.tail123.ts.net' },
        { ...station, appOrigin, port: 0 },
        { ...station, appOrigin, port: 65536 },
        { ...station, appOrigin, transport: 'file' },
      ],
    });
    const result = await discoverConnectionCandidates();
    expect(result.candidates).toEqual([]);
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
    finish?.({
      status: 'available',
      candidates: [{ ...station, appOrigin: 'https://office.tail123.ts.net' }],
    });
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
