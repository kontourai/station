import { describe, expect, it } from 'vitest';
import {
  bindHostTunnelAccess,
  createDirectHttpAccessMethod,
  createHostTunnelAccessMethod,
  requiresHostAdapter,
} from '../core/accessMethods';
import { createAccessEndpoint } from '../core/environmentProfiles';

describe('environment access methods', () => {
  it('represents direct HTTP as a stable reference to a persisted endpoint', () => {
    const endpoint = createAccessEndpoint(
      'https://station.example-tailnet.ts.net',
    );

    expect(createDirectHttpAccessMethod(endpoint)).toEqual({
      accessVersion: 1,
      id: `access:direct:${endpoint.id}`,
      kind: 'direct-http',
      endpointId: endpoint.id,
    });
  });

  it('creates a credential-free SSH reference and marks it host-managed', () => {
    const method = createHostTunnelAccessMethod({
      id: 'access:ssh:media-station',
      hostAlias: ' brian-media ',
      remoteProjectPath: ' ~/dev/github/kontourai/station ',
    });

    expect(method).toEqual({
      accessVersion: 1,
      id: 'access:ssh:media-station',
      kind: 'host-tunnel',
      adapter: 'ssh',
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });
    expect(requiresHostAdapter(method)).toBe(true);
    expect(JSON.stringify(method)).not.toMatch(
      /privateKey|identityFile|bearer|secret|token|controlPath|localForward/i,
    );
  });

  it.each([
    ['host alias whitespace', 'media server', '/srv/station'],
    ['host alias option injection', '-F', '/srv/station'],
    ['project newline', 'media', '/srv/station\nmalicious'],
  ])('rejects unsafe %s', (_label, hostAlias, remoteProjectPath) => {
    expect(() =>
      createHostTunnelAccessMethod({
        id: 'access:ssh:test',
        hostAlias,
        remoteProjectPath,
      }),
    ).toThrow();
  });

  it('binds only loopback adapter output with the exact remote project root', () => {
    const method = createHostTunnelAccessMethod({
      id: 'access:ssh:media-station',
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });
    const endpoint = createAccessEndpoint('http://127.0.0.1:43141');

    expect(
      bindHostTunnelAccess(method, {
        endpoint,
        hostIdentity: 'SHA256:fixture-host-key',
        remoteProjectPath: '/srv/station',
      }),
    ).toEqual({
      accessMethodId: method.id,
      endpoint,
      hostIdentity: 'SHA256:fixture-host-key',
      remoteProjectPath: '/srv/station',
    });
    expect(() =>
      bindHostTunnelAccess(method, {
        endpoint: createAccessEndpoint('http://192.168.1.20:3141'),
        hostIdentity: 'SHA256:fixture-host-key',
        remoteProjectPath: '/srv/station',
      }),
    ).toThrow('loopback');
    expect(() =>
      bindHostTunnelAccess(method, {
        endpoint,
        hostIdentity: 'SHA256:fixture-host-key',
        remoteProjectPath: '/srv/other',
      }),
    ).toThrow('does not match');
  });
});
