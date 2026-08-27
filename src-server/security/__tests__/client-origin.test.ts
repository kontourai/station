import { describe, expect, it } from 'vitest';
import {
  resolveClientOriginForRequest,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

describe('resolveClientOriginForRequest', () => {
  it('uses the authenticated device identity, not a client header', () => {
    const request = new Request('http://station.test/api/tasks', {
      headers: {
        'X-Station-Client-Origin': '1;mobile;1.2.3',
        'X-Station-Device-Id': 'forged-device',
      },
    });
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'never-persisted',
      authority: 'device-credential',
      deviceId: 'device-server-42',
      source: 'bearer',
    });

    expect(resolveClientOriginForRequest(request)).toEqual({
      version: 1,
      actor: { kind: 'device', deviceId: 'device-server-42' },
      reported: { version: 1, surface: 'mobile', build: '1.2.3' },
    });
  });

  it('keeps an old client honest as unknown', () => {
    const request = new Request('http://station.test/api/tasks');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'operator-secret',
      authority: 'operator-credential',
      source: 'session',
    });
    expect(resolveClientOriginForRequest(request)).toMatchObject({
      actor: { kind: 'operator' },
      reported: { surface: 'unknown', build: null },
    });
  });
});
