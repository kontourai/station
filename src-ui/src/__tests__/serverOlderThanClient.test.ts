import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  deriveServerOlderOffer,
  readableVersions,
  type ServerOlderFacts,
  serverOlderNoticeContent,
} from '../lib/serverOlderThanClient';

/** The shape `GET /api/system/core-update` gives for a service-run archive. */
function serviceArchive(
  overrides: Partial<CoreUpdateStatus> = {},
): CoreUpdateStatus {
  return {
    installKind: 'archive-service',
    applyMethod: 'service-update',
    channel: 'nightly',
    currentVersion: '0.1.11-nightly.246303',
    latestVersion: '0.1.11-nightly.246500',
    releaseCheck: 'verified',
    updateAvailable: true,
    selfUpdateUnavailableReason: null,
    selfUpdateUnavailableCode: null,
    serverIdentity: { instanceId: 'inst', bootId: 'boot', sha: 'abc' },
    serviceUpdate: { state: 'idle' },
    ...overrides,
  } as CoreUpdateStatus;
}

function facts(overrides: Partial<ServerOlderFacts> = {}): ServerOlderFacts {
  return {
    // Native Nightly day 2465 = version code 246500, newer than 246303.
    clientVersion: '0.1.11-nightly.2465',
    status: serviceArchive(),
    checkFailed: false,
    current: true,
    identityMatches: true,
    ...overrides,
  };
}

describe('deriveServerOlderOffer: when the server is older', () => {
  test('offers the update a service-run archive can apply from here', () => {
    expect(deriveServerOlderOffer(facts())).toEqual({
      kind: 'update',
      client: '0.1.11-nightly.2465',
      server: '0.1.11-nightly.246303',
      // Day 2463 is 2026-09-29, day 2465 is 2026-10-01.
      clientLabel: 'Nightly Oct 1',
      serverLabel: 'Nightly Sep 29, build 3',
      target: '0.1.11-nightly.246500',
    });
  });

  // iOS Nightly and Beta builds were stamped with Apple's bare marketing
  // version (nightly-native-stage.yml ios_identity, release.yml
  // ios_marketing_version); such a client must never read as newer than a
  // prerelease of its own release.
  test.each([
    [
      'an iOS Nightly stamped 0.1.11 meets a Nightly server',
      '0.1.11-nightly.246303',
    ],
    ['an iOS Beta stamped 0.1.11 meets a preview server', '0.1.11-preview.3'],
    // Accepted: a genuine stable client is quiet against a preview of its
    // own release, which tracks another ring and cannot self-update to it.
    ['a stable 0.1.11 client meets its own preview', '0.1.11-preview.3'],
  ])('says nothing when %s', (_label, currentVersion) => {
    expect(
      deriveServerOlderOffer(
        facts({
          clientVersion: '0.1.11',
          status: serviceArchive({ currentVersion }),
        }),
      ),
    ).toEqual({ kind: 'none' });
  });

  test('an iOS Nightly with its full stamp compares like any Nightly', () => {
    // nightly-native-stage.yml now passes the cohort's desktop version.
    expect(
      deriveServerOlderOffer(facts({ clientVersion: '0.1.11-nightly.2465' }))
        .kind,
    ).toBe('update');
  });

  test('a bare client of a newer release still sees an older prerelease server', () => {
    expect(
      deriveServerOlderOffer(facts({ clientVersion: '0.1.12' })).kind,
    ).toBe('update');
  });

  test.each([
    ['equal versions', '0.1.11-nightly.2463.3'],
    ['an older client', '0.1.11-nightly.2400'],
    ['a dev or local build', null],
    ['another ring of the same release', '0.1.11-preview.1'],
    ['an unparseable version', '0.1.11-nightly.2465.100'],
  ])('says nothing for %s', (_label, clientVersion) => {
    expect(deriveServerOlderOffer(facts({ clientVersion }))).toEqual({
      kind: 'none',
    });
  });

  test('compares versions, never substrings', () => {
    // "0.1.1" is a prefix of the server's version and lexically smaller than
    // "0.1.11", but a newer minor is newer.
    expect(
      deriveServerOlderOffer(
        facts({
          clientVersion: '0.2.1',
          status: serviceArchive({ currentVersion: '0.10.0' }),
        }),
      ).kind,
    ).toBe('none');
    expect(
      deriveServerOlderOffer(
        facts({
          clientVersion: '0.10.0',
          status: serviceArchive({ currentVersion: '0.9.99' }),
        }),
      ).kind,
    ).toBe('update');
  });

  test.each([
    ['no answer yet', { status: undefined }],
    ['a failed check', { checkFailed: true }],
    ['a superseded or unreachable server', { current: false }],
    [
      'a server that states no version',
      {
        status: {
          installKind: 'source-checkout',
          updateAvailable: true,
        } as CoreUpdateStatus,
      },
    ],
  ])('says nothing on %s', (_label, overrides) => {
    expect(deriveServerOlderOffer(facts(overrides)).kind).toBe('none');
  });
});

describe('deriveServerOlderOffer: no dead button', () => {
  test.each<[string, Partial<CoreUpdateStatus>, RegExp]>([
    [
      'a refusal the server states',
      { selfUpdateUnavailableReason: 'stop the service first' },
      /cannot be updated from here: stop the service first/,
    ],
    [
      'an archive the service does not run',
      {
        installKind: 'archive',
        applyMethod: 'station-upgrade',
      },
      /station upgrade/,
    ],
    [
      'a ring with nothing newer',
      { updateAvailable: false, latestVersion: '0.1.11-nightly.246303' },
      /newest nightly release/,
    ],
    [
      'an unreachable manifest',
      {
        releaseCheck: 'unreachable',
        updateAvailable: false,
        message: 'Could not reach the nightly release manifest.',
      },
      /Could not reach the nightly release manifest\. Run "station upgrade"/,
    ],
    [
      'an update already running',
      {
        serviceUpdate: {
          state: 'staging',
          requestId: 'r0',
        },
      },
      /already under way/,
    ],
  ])('explains instead for %s', (_label, overrides, remedy) => {
    const offer = deriveServerOlderOffer(
      facts({ status: serviceArchive(overrides) }),
    );
    expect(offer.kind).toBe('manual');
    expect(offer.kind === 'manual' && offer.remedy).toMatch(remedy);
  });

  test('never offers an apply to a server it cannot correlate', () => {
    const offer = deriveServerOlderOffer(facts({ identityMatches: false }));
    expect(offer.kind).toBe('manual');
  });
});

describe('serverOlderNoticeContent', () => {
  test('names both readable versions and preserves raw versions in the guidance', () => {
    const content = serverOlderNoticeContent(deriveServerOlderOffer(facts()));
    expect(content?.message).toBe(
      'This Station server runs Nightly Sep 29, build 3, which is older than this app (Nightly Oct 1).',
    );
    expect(content?.detail).toMatch(
      /^Server 0\.1\.11-nightly\.246303, app 0\.1\.11-nightly\.2465\./,
    );
  });

  test('no offer produces no notice', () => {
    expect(serverOlderNoticeContent({ kind: 'none' })).toBeNull();
  });
});

describe('readableVersions', () => {
  test.each<[string, string, [string, string]]>([
    [
      '0.1.11-nightly.246500',
      '0.1.11-nightly.246303',
      ['Nightly Oct 1', 'Nightly Sep 29, build 3'],
    ],
    // The release is named only when the two differ in it.
    [
      '0.1.12-nightly.246500',
      '0.1.11-nightly.246303',
      ['0.1.12 Nightly Oct 1', '0.1.11 Nightly Sep 29, build 3'],
    ],
    // The year only when the two dates differ in it.
    [
      '0.1.11-nightly.256500',
      '0.1.11-nightly.246303',
      ['Nightly Jan 9, 2027', 'Nightly Sep 29, 2026, build 3'],
    ],
    // The dated shape #2962 introduces reads the same way.
    [
      '0.1.11-nightly.20261011.2',
      '0.1.11-nightly.246303',
      ['Nightly Oct 11, build 2', 'Nightly Sep 29, build 3'],
    ],
    // Releases and previews keep their version.
    ['0.2.0', '0.1.11-preview.3', ['0.2.0', '0.1.11-preview.3']],
  ])('%s and %s', (left, right, expected) => {
    expect(readableVersions(left, right)).toEqual(expected);
  });
});

describe('a server that downloads and restarts as separate steps (#3851)', () => {
  test('a staged service points to the shared Updates confirmation', () => {
    expect(
      deriveServerOlderOffer(
        facts({ status: serviceArchive({ stagedUpdates: true }) }),
      ),
    ).toMatchObject({
      kind: 'manual',
      remedy: expect.stringContaining('from Updates'),
    });
    expect(
      deriveServerOlderOffer(
        facts({
          status: serviceArchive({
            stagedUpdates: true,
            serviceUpdate: {
              state: 'staged',
              requestId: 'r-1',
              version: '0.1.11-nightly.246500',
              stagedAt: '2026-10-19T10:00:00.000Z',
            },
          }),
        }),
      ),
    ).toMatchObject({
      kind: 'manual',
      remedy: expect.stringContaining('0.1.11-nightly.246500 is downloaded'),
    });
  });
});
