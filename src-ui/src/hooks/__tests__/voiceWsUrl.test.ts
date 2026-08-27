import { describe, expect, it } from 'vitest';
import { deriveVoiceWsUrl } from '../voiceWsUrl';

describe('deriveVoiceWsUrl (#198)', () => {
  it('derives ws:// using the fetched voice port for a plain-port http origin', () => {
    expect(
      deriveVoiceWsUrl(
        'http://192.168.1.42:3010',
        'http://192.168.1.42:3010/',
        3012,
      ),
    ).toBe('ws://192.168.1.42:3012/?agent=station-voice');
  });

  it('derives wss:// (not ws://) for an https origin — avoids mixed-content blocking', () => {
    expect(
      deriveVoiceWsUrl(
        'https://my-tailnet-host.ts.net',
        'https://my-tailnet-host.ts.net/',
        445,
      ),
    ).toBe('wss://my-tailnet-host.ts.net:445/?agent=station-voice');
  });

  it('uses the fetched voice port even when apiBase has no explicit port', () => {
    expect(
      deriveVoiceWsUrl('http://station.local', 'http://station.local/', 82),
    ).toBe('ws://station.local:82/?agent=station-voice');
  });

  it('does not throw for a relative/empty apiBase — resolves the host against the page href instead', () => {
    expect(() =>
      deriveVoiceWsUrl('', 'http://localhost:5274/settings', 5276),
    ).not.toThrow();
    // With an empty apiBase, the host comes from the *page* href (the
    // resolved same-origin default in a real app); the port always comes
    // from the fetched voicePort, never from apiBase/page arithmetic.
    expect(deriveVoiceWsUrl('', 'http://localhost:5274/settings', 5276)).toBe(
      'ws://localhost:5276/?agent=station-voice',
    );
  });

  it('resolves localhost the same way as any other same-origin host', () => {
    expect(
      deriveVoiceWsUrl('http://localhost:3141', 'http://localhost:3141/', 3143),
    ).toBe('ws://localhost:3143/?agent=station-voice');
  });

  it('code review H2 regression: a plain default `station start` (UI port !== server port) resolves the REAL server-derived voice port, not apiBase-port-plus-2', () => {
    // The exact scenario the review proved broken: no STATION_API_BASE
    // override configured, so apiBase resolves to the UI's own
    // same-origin origin (window.location.origin) — the UI port
    // (`--ui-port`, default 3000), which is independent of the server
    // port (default 3141) that Voice's dedicated WS server actually binds
    // at (`serverPort + 2` = 3143). The old `apiBase-port + 2` arithmetic
    // would have computed 3002 here — silently wrong. `voicePort` must
    // come from the backend-queried value (`fetchVoicePort`, see
    // `useVoiceSession.ts`), never from apiBase's own port.
    const uiOriginApiBase = 'http://localhost:3000'; // UI port, NOT server port
    const realVoicePortFromBackend = 3143; // serverPort (3141) + 2
    const result = deriveVoiceWsUrl(
      uiOriginApiBase,
      'http://localhost:3000/',
      realVoicePortFromBackend,
    );
    expect(result).toBe('ws://localhost:3143/?agent=station-voice');
    // Explicitly not the old broken arithmetic result.
    expect(result).not.toBe('ws://localhost:3002/?agent=station-voice');
  });
});
