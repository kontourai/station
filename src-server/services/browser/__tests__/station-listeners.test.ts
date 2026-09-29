import { describe, expect, test } from 'vitest';
import {
  deriveStationListeners,
  isLocalAddress,
  isStationSelfUrl,
  stationSelfFetchPatterns,
} from '../station-listeners.js';

describe('deriveStationListeners', () => {
  test('the server, terminal, voice and consent listeners', () => {
    expect(
      deriveStationListeners({ serverPort: 4100, configuredOrigins: [] }),
    ).toEqual({ ports: [4100, 4101, 4102, 4103], hostnames: [] });
  });

  test('an explicit consent port replaces the +3 default', () => {
    expect(
      deriveStationListeners({
        serverPort: 4100,
        consentPort: 5999,
        configuredOrigins: [],
      }).ports,
    ).toEqual([4100, 4101, 4102, 5999]);
  });

  test('configured origins add the UI listener port and tailnet origins', () => {
    const listeners = deriveStationListeners({
      serverPort: 4100,
      configuredOrigins: [
        'http://localhost:4200',
        'http://127.0.0.1:4200',
        'https://Box.tail1234.ts.net',
        'tauri://localhost',
        'not a url',
      ],
    });
    expect(listeners).toEqual({
      ports: [443, 4100, 4101, 4102, 4103, 4200],
      hostnames: ['box.tail1234.ts.net'],
    });
  });

  test('other registered instances contribute their whole block and UI port', () => {
    expect(
      deriveStationListeners({
        serverPort: 4100,
        configuredOrigins: [],
        otherInstances: [
          { port: 3141, uiPort: 3000 },
          { port: 5000, consentPort: 6000 },
          { port: Number.NaN },
        ],
      }).ports,
    ).toEqual([
      3000, 3141, 3142, 3143, 3144, 4100, 4101, 4102, 4103, 5000, 5001, 5002,
      6000,
    ]);
  });

  test('refuses to derive without a real server port', () => {
    expect(() =>
      deriveStationListeners({ serverPort: 0, configuredOrigins: [] }),
    ).toThrow(/server port/);
  });
});

describe('isLocalAddress', () => {
  test('isLocalAddress treats all of 127/8 and the unspecified addresses as local', () => {
    expect(isLocalAddress('127.255.0.1', [])).toBe(true);
    expect(isLocalAddress('[::1]', [])).toBe(true);
    expect(isLocalAddress('8.8.8.8', [])).toBe(false);
  });
});

describe('isStationSelfUrl (URL-level defence in depth)', () => {
  const listeners = deriveStationListeners({
    serverPort: 4100,
    configuredOrigins: ['https://box.tail1234.ts.net'],
  });

  test.each([
    ['http://127.0.0.1:4100/api/system', true],
    ['http://localhost:4101/', true],
    ['ws://[::1]:4102/voice', true],
    ['http://0.0.0.0:4103/', true],
    ['http://[::ffff:127.0.0.1]:4100/', true],
    ['http://[::ffff:7f00:1]:4100/', true],
    ['http://[0:0:0:0:0:ffff:7f00:1]:4100/', true],
    ['ws://[::127.0.0.1]:4101/', true],
    ['http://rebind.localhost:4100/', true],
    ['http://192.168.1.20:4100/', true],
    ['https://box.tail1234.ts.net/', true],
    ['http://127.0.0.1:5173/', false],
    ['http://evil.example:4100/', false],
    ['https://example.com/?next=http://127.0.0.1:4100/', false],
    ['not a url', false],
  ])('%s -> %s', (url, blocked) => {
    expect(isStationSelfUrl(url, listeners, ['192.168.1.20'])).toBe(blocked);
  });

  test('fetch patterns cover every listener port and default-port hosts', () => {
    expect(stationSelfFetchPatterns(listeners)).toEqual([
      '*:4100/*',
      '*:4101/*',
      '*:4102/*',
      '*:4103/*',
      '*://localhost/*',
      '*://127.0.0.1/*',
      '*://[::1]/*',
      '*://box.tail1234.ts.net/*',
    ]);
  });
});
