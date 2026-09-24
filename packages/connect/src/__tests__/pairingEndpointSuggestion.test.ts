import { describe, expect, test } from 'vitest';
import {
  forgetPairingEndpoint,
  rememberPairingEndpoint,
  suggestPairingEndpoint,
} from '../core/pairingEndpointSuggestion';

const apiBase = 'https://station.example.test';

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => void map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage & { map: Map<string, string> };
}

describe('pairing endpoint suggestions (#2228 slice 3)', () => {
  test('remembers a reachable address and offers it back for the same Station only', () => {
    const storage = memoryStorage();
    rememberPairingEndpoint(
      apiBase,
      'https://kontour.python-smelt.ts.net:3773',
      storage,
    );
    expect(suggestPairingEndpoint(apiBase, storage)).toBe(
      'https://kontour.python-smelt.ts.net:3773',
    );
    expect(
      suggestPairingEndpoint('https://other-station.example.test', storage),
    ).toBeUndefined();
  });

  test('does not remember a loopback address and forgets a previous one', () => {
    const storage = memoryStorage();
    rememberPairingEndpoint(
      apiBase,
      'https://kontour.python-smelt.ts.net:3773',
      storage,
    );
    // The operator chose loopback deliberately: the old tailnet URL must not
    // resurface over that choice.
    rememberPairingEndpoint(apiBase, 'http://127.0.0.1:38141', storage);
    expect(suggestPairingEndpoint(apiBase, storage)).toBeUndefined();
    expect(
      storage.map.has(
        'station-pairing-endpoint-suggestion:v1:https://station.example.test',
      ),
    ).toBe(false);
  });

  test('reads a corrupt or loopback-again stored value as absent', () => {
    const storage = memoryStorage();
    storage.map.set(
      'station-pairing-endpoint-suggestion:v1:https://station.example.test',
      'not a url',
    );
    expect(suggestPairingEndpoint(apiBase, storage)).toBeUndefined();
    storage.map.set(
      'station-pairing-endpoint-suggestion:v1:https://station.example.test',
      'http://localhost:3141',
    );
    expect(suggestPairingEndpoint(apiBase, storage)).toBeUndefined();
  });

  test('storage failures degrade to no suggestion, never a throw', () => {
    const throwing = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };
    expect(() =>
      rememberPairingEndpoint(
        apiBase,
        'https://kontour.python-smelt.ts.net:3773',
        throwing,
      ),
    ).not.toThrow();
    expect(suggestPairingEndpoint(apiBase, throwing)).toBeUndefined();
  });

  test('forgetPairingEndpoint removes the suggestion', () => {
    const storage = memoryStorage();
    rememberPairingEndpoint(
      apiBase,
      'https://kontour.python-smelt.ts.net:3773',
      storage,
    );
    forgetPairingEndpoint(apiBase, storage);
    expect(suggestPairingEndpoint(apiBase, storage)).toBeUndefined();
  });
});
