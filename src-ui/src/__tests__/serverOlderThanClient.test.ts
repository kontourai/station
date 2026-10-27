import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  deriveServerOlderOffer,
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
      'a refusal the server states with nothing to apply',
      {
        selfUpdateUnavailableReason: 'stop the service first',
        updateAvailable: false,
      },
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
      /No newer nightly server release yet/,
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
  test('says only that the server is older when the section offers the update', () => {
    // Both versions are already shown once: the server's in its section
    // header, the app's in the app section.
    expect(serverOlderNoticeContent(deriveServerOlderOffer(facts()))).toEqual({
      message: 'Server is older than this app.',
      detail: undefined,
    });
  });

  test('adds a remedy the section does not show', () => {
    const content = serverOlderNoticeContent(
      deriveServerOlderOffer(
        facts({
          status: serviceArchive({
            installKind: 'archive',
            applyMethod: 'station-upgrade',
          }),
        }),
      ),
    );
    expect(content?.detail).toMatch(/station upgrade/);
    expect(content?.detail).not.toContain('0.1.11-nightly');
  });

  test('no offer produces no notice', () => {
    expect(serverOlderNoticeContent({ kind: 'none' })).toBeNull();
  });
});

describe('remedies the Updates server section already shows (#3851)', () => {
  test.each<[string, Partial<CoreUpdateStatus>]>([
    ['a staged-update service, before download', { stagedUpdates: true }],
    [
      'a staged-update service, once downloaded',
      {
        stagedUpdates: true,
        serviceUpdate: {
          state: 'staged',
          requestId: 'r-1',
          version: '0.1.11-nightly.246500',
          stagedAt: '2026-10-19T10:00:00.000Z',
        },
      },
    ],
    [
      'an update already running',
      { serviceUpdate: { state: 'staging', requestId: 'r0' } },
    ],
    [
      'a refusal stated beside an available update',
      { selfUpdateUnavailableReason: 'stop the service first' },
    ],
  ])('%s adds no remedy', (_label, overrides) => {
    const offer = deriveServerOlderOffer(
      facts({ status: serviceArchive(overrides) }),
    );
    expect(offer).toMatchObject({ kind: 'manual', remedy: null });
    expect(serverOlderNoticeContent(offer)?.detail).toBeUndefined();
  });
});
