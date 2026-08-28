/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test } from 'vitest';
import { resolveCspNonce } from '../utils/csp';

afterEach(() => {
  delete (window as Window & { __STATION_CSP_NONCE__?: unknown })
    .__STATION_CSP_NONCE__;
  document.head.replaceChildren();
});

describe('resolveCspNonce', () => {
  test('ignores a page global claiming to hold the shell nonce', () => {
    // archive#4287: the HTTP shell no longer publishes its per-response nonce
    // to page code, and this resolver no longer reads such a global — a value
    // any plugin bundle could also read is not a nonce this shell will reuse.
    (
      window as Window & {
        __STATION_CSP_NONCE__?: unknown;
      }
    ).__STATION_CSP_NONCE__ = 'server-nonce';

    expect(resolveCspNonce()).toBeUndefined();
  });

  test('rejects a malformed document nonce value', () => {
    const script = document.createElement('script');
    script.nonce = 'also bad';
    script.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(script);

    expect(resolveCspNonce()).toBeUndefined();
  });

  test('uses only the dedicated Tauri marker after its token is replaced', () => {
    const unrelated = document.createElement('script');
    unrelated.nonce = 'unrelated-nonce';
    document.head.appendChild(unrelated);
    const marker = document.createElement('script');
    marker.nonce = '__TAURI_SCRIPT_NONCE__';
    marker.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(marker);

    expect(resolveCspNonce()).toBeUndefined();

    marker.nonce = 'tauri-runtime-nonce';
    expect(resolveCspNonce()).toBe('tauri-runtime-nonce');
  });
});
