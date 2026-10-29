import { describe, expect, it } from 'vitest';
import {
  MAX_STATION_ROUTES,
  parseStationRoutesResponse,
} from '../station-routes';

describe('parseStationRoutesResponse', () => {
  it('keeps valid origins and drops invalid, duplicate or unknown entries', () => {
    expect(
      parseStationRoutesResponse({
        environmentId: 'env-a',
        routes: [
          { kind: 'lan', url: 'http://192.168.1.20:3141' },
          { kind: 'lan', url: 'http://192.168.1.20:3141' },
          { kind: 'tailscale', url: 'http://100.70.1.2:3141' },
          { kind: 'tailscale-https', url: 'https://box.tail1.ts.net' },
          { kind: 'lan', url: 'http://192.168.1.20:3141/api' },
          { kind: 'lan', url: 'ftp://192.168.1.20' },
          { kind: 'lan', url: 'http://user:pw@192.168.1.20:3141' },
          { kind: 'relay', url: 'https://relay.example' },
          null,
        ],
      }),
    ).toEqual({
      environmentId: 'env-a',
      routes: [
        { kind: 'lan', url: 'http://192.168.1.20:3141' },
        { kind: 'tailscale', url: 'http://100.70.1.2:3141' },
        { kind: 'tailscale-https', url: 'https://box.tail1.ts.net' },
      ],
    });
  });

  it('refuses an answer without an environment identity or route list', () => {
    expect(parseStationRoutesResponse({ routes: [] })).toBeNull();
    expect(
      parseStationRoutesResponse({ environmentId: '', routes: [] }),
    ).toBeNull();
    expect(parseStationRoutesResponse({ environmentId: 'env-a' })).toBeNull();
    expect(parseStationRoutesResponse('nope')).toBeNull();
  });

  it('caps how many routes one answer can add', () => {
    const routes = Array.from({ length: MAX_STATION_ROUTES + 5 }, (_, i) => ({
      kind: 'lan',
      url: `http://192.168.1.${i + 1}:3141`,
    }));
    expect(
      parseStationRoutesResponse({ environmentId: 'env-a', routes })?.routes,
    ).toHaveLength(MAX_STATION_ROUTES);
  });
});
