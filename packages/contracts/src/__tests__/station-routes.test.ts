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

  it.each(['configured', 'tailscale', 'unavailable'] as const)(
    'parses publication metadata from %s without turning approval origins into app routes',
    (source) => {
      const publication = {
        consentOrigin:
          source === 'unavailable' ? null : 'https://approval.example.com',
        source,
        appOrigins: ['http://100.70.1.2:3141', 'https://app.example.com'],
        status: source === 'unavailable' ? 'unavailable' : 'ready',
      };
      expect(
        parseStationRoutesResponse({
          environmentId: 'env-a',
          routes: [],
          publication,
        }),
      ).toEqual({ environmentId: 'env-a', routes: [], publication });
    },
  );

  it.each([
    'http://approval.example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://approval.example.com:0',
    'https://0x7f.1',
    'https://approval.example.com:443',
    'https://Approval.example.com',
    'https://' + 'a'.repeat(254),
    'https://user:secret@approval.example.com',
    'https://approval.example.com/',
    'https://approval.example.com/approve',
    'https://approval.example.com?token=secret',
    'https://approval.example.com#approve',
    'https://bad_name.example.com',
    'https://approval.example.com.',
    '',
  ])(
    'drops unsafe approval publication %s while retaining app routes',
    (consentOrigin) => {
      const routes = [{ kind: 'lan', url: 'http://192.168.1.20:3141' }];
      expect(
        parseStationRoutesResponse({
          environmentId: 'env-a',
          routes,
          publication: {
            consentOrigin,
            source: 'configured',
            appOrigins: [],
            status: 'ready',
          },
        }),
      ).toEqual({ environmentId: 'env-a', routes });
    },
  );

  it.each([
    null,
    { consentOrigin: 12 },
    { consentOrigin: null },
    { source: 'unavailable' },
    { source: 'proxy' },
    { status: 'pending' },
    { appOrigins: 'https://app.example.com' },
    { appOrigins: ['https://app.example.com/path'] },
    { appOrigins: [null] },
    {
      appOrigins: Array.from(
        { length: MAX_STATION_ROUTES + 1 },
        () => 'https://app.example.com',
      ),
    },
  ])('ignores malformed publication fields: %j', (override) => {
    const publication =
      override === null
        ? null
        : {
            consentOrigin: 'https://approval.example.com',
            source: 'configured',
            appOrigins: [],
            status: 'ready',
            ...override,
          };
    expect(
      parseStationRoutesResponse({
        environmentId: 'env-a',
        routes: [],
        publication,
      }),
    ).toEqual({ environmentId: 'env-a', routes: [] });
  });

  it.each(['unavailable', 'ambiguous', 'disabled'] as const)(
    'preserves the %s publication status without an approval origin',
    (status) => {
      expect(
        parseStationRoutesResponse({
          environmentId: 'env-a',
          routes: [],
          publication: {
            consentOrigin: null,
            source: 'unavailable',
            appOrigins: [],
            status,
          },
        })?.publication?.status,
      ).toBe(status);
    },
  );

  it.each(['https://localhost:4443', 'https://approval.example.com:8443'])(
    'preserves supported exact HTTPS DNS origins including custom ports: %s',
    (consentOrigin) => {
      expect(
        parseStationRoutesResponse({
          environmentId: 'env-a',
          routes: [],
          publication: {
            consentOrigin,
            source: 'configured',
            appOrigins: [],
            status: 'ready',
          },
        })?.publication?.consentOrigin,
      ).toBe(consentOrigin);
    },
  );
});
