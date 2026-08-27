/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test } from 'vitest';
import {
  remotePluginBundlesAllowed,
  remotePluginBundlesAllowedKey,
  setRemotePluginBundlesAllowed,
} from '../core/remotePluginBundleConsent';

const CONNECTION_ID = 'remote-profile';
const ORIGIN_X = 'https://station-x.example.test/api';
const ORIGIN_Y = 'https://station-y.example.test/api';

afterEach(() => window.localStorage.clear());

describe('remote plugin bundle consent', () => {
  test('binds consent to the granted origin when a saved Station endpoint changes', () => {
    expect(setRemotePluginBundlesAllowed(CONNECTION_ID, ORIGIN_X, true)).toBe(
      true,
    );

    expect(remotePluginBundlesAllowed(CONNECTION_ID, ORIGIN_Y)).toBe(false);
    expect(remotePluginBundlesAllowed(CONNECTION_ID, ORIGIN_X)).toBe(true);
  });

  test('blocks malformed stored consent values', () => {
    window.localStorage.setItem(
      remotePluginBundlesAllowedKey(CONNECTION_ID),
      'not-an-origin',
    );

    expect(remotePluginBundlesAllowed(CONNECTION_ID, ORIGIN_X)).toBe(false);
  });
});
