import { describe, expect, it } from 'vitest';
import {
  createDirectHttpAccessMethod,
  createHostTunnelAccessMethod,
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
      hostAlias: ' home-media ',
      remoteProjectPath: ' ~/dev/github/kontourai/station ',
    });

    expect(method).toEqual({
      accessVersion: 1,
      id: 'access:ssh:media-station',
      kind: 'host-tunnel',
      adapter: 'ssh',
      hostAlias: 'home-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });
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
});
