import { describe, expect, it } from 'vitest';
import {
  type AppErrorObservation,
  createFailedRequestLog,
  diffControlNames,
  formatAppErrorIdentity,
  formatLayoutShiftTable,
  isChunkPath,
  MAX_FAILED_REQUESTS,
  readGalleryFaults,
  shouldCaptureAgain,
  summariseLayoutShifts,
  withoutAssetHash,
} from '../../tests/helpers/gallery-app-error-state';
import { createDocumentTracker } from '../../tests/helpers/gallery-document-tracker';

const origin = 'http://localhost:5314';
const failing = (
  path: string,
  errorText = 'net::ERR_ABORTED',
  resourceType = 'script',
) => ({
  url: () => new URL(path, origin).href,
  resourceType: () => resourceType,
  failure: () => ({ errorText }),
});

const observation = (
  overrides: Partial<AppErrorObservation> = {},
): AppErrorObservation => ({
  surfaces: { 'lazy-boundary-row': 1 },
  phase: 'before capture',
  failedRequests: [],
  failedRequestsOmitted: 0,
  consoleErrors: [],
  ...overrides,
});

describe('app error identity', () => {
  it('names the surface, the phase and the failed requests on one line, without build hashes', () => {
    const identity = formatAppErrorIdentity(
      observation({
        surfaces: { 'extension-registry-toast': 1, 'lazy-boundary-row': 2 },
        phase: 'after capture',
        failedRequests: [
          {
            path: '/api/orchestration/events',
            errorText: 'net::ERR_ABORTED',
            resourceType: 'fetch',
            failedAt: 1,
            document: 'previous',
          },
          {
            path: '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
            errorText: 'net::ERR_ABORTED',
            resourceType: 'script',
            failedAt: 2,
            document: 'current',
          },
        ],
      }),
    );
    expect(identity).toBe(
      'app-error-surface: extension-registry-toast, lazy-boundary-row; after capture; failed requests: /assets/CoreUpdateLaunchCheck-<hash>.js net::ERR_ABORTED (script, current document), /api/orchestration/events net::ERR_ABORTED (fetch, previous document)',
    );
    expect(identity).not.toContain('\n');
  });

  it('bounds the requests it shows and counts the rest, including those the log dropped', () => {
    const failedRequests = Array.from({ length: 6 }, (_, index) => ({
      path: `/assets/chunk${index}-abcdefgh.js`,
      errorText: 'net::ERR_FAILED',
      resourceType: 'script',
      failedAt: index,
      document: 'current' as const,
    }));
    const identity = formatAppErrorIdentity(
      observation({ failedRequests, failedRequestsOmitted: 3 }),
    );
    expect(identity.match(/chunk\d-<hash>\.js/g)).toHaveLength(4);
    expect(identity).toMatch(/, \+5 more$/);
    expect(formatAppErrorIdentity(observation())).toBe(
      'app-error-surface: lazy-boundary-row; before capture; failed requests: none recorded',
    );
    expect(
      formatAppErrorIdentity(
        observation({
          phase: 'during capture',
          stepError: 'locator.waitFor: Timeout 10000ms exceeded.',
        }),
      ),
    ).toMatch(
      /; during capture; .*; step error: locator\.waitFor: Timeout 10000ms exceeded\.$/,
    );
  });

  it('replaces only a content hash in an asset name', () => {
    expect(withoutAssetHash('/assets/PluginRegistryGate-C4ju9qqc.js')).toBe(
      '/assets/PluginRegistryGate-<hash>.js',
    );
    expect(withoutAssetHash('/assets/nested/a-b-0123456789.css')).toBe(
      '/assets/nested/a-b-<hash>.css',
    );
    expect(withoutAssetHash('/assets/short-abc.js')).toBe(
      '/assets/short-abc.js',
    );
    expect(withoutAssetHash('/api/projects')).toBe('/api/projects');
  });
});

describe('the single second capture', () => {
  it('captures again only a first attempt that failed on an app error surface', () => {
    const appError = observation();
    expect(shouldCaptureAgain(1, { ok: false, appError }, 'home')).toBe(true);
    // An ordinary assertion or audit failure has no surface.
    expect(shouldCaptureAgain(1, { ok: false, appError: null }, 'home')).toBe(
      false,
    );
    expect(shouldCaptureAgain(1, { ok: true, appError: null }, 'home')).toBe(
      false,
    );
    // Never a third capture.
    expect(shouldCaptureAgain(2, { ok: false, appError }, 'home')).toBe(false);
  });
});

describe('failed request log', () => {
  // The event orders a local capture produced: the old document keeps
  // issuing requests after the next navigation request starts, and its
  // aborts can arrive before `framenavigated`.
  it('tells a live-page failure from a previous document torn down by navigation', () => {
    let clock = 1_000;
    const documents = createDocumentTracker();
    const log = createFailedRequestLog(origin, documents, () => clock);
    const fail = (request: ReturnType<typeof failing>) => {
      log.failed(request);
      documents.settled(request, true);
    };
    const first = failing('/first', 'net::ERR_ABORTED', 'document');
    documents.issued(first, true);
    documents.committed();
    const stale = failing('/api/projects', 'net::ERR_ABORTED', 'fetch');
    documents.issued(stale, false);
    const next = failing('/second', 'net::ERR_ABORTED', 'document');
    documents.issued(next, true);
    // Issued by the old document while the navigation is pending.
    const late = failing('/api/projects/late', 'net::ERR_ABORTED', 'fetch');
    documents.issued(late, false);
    clock = 2_000;
    fail(stale); // before framenavigated
    documents.committed();
    fail(late); // after it
    const chunk = failing('/assets/CoreUpdateLaunchCheck-DDGWUae_.js?v=1#x');
    documents.issued(chunk, false);
    clock = 3_000;
    fail(chunk);
    // A history-API navigation commits no new document.
    documents.committed();
    const elsewhere = failing('http://other.invalid/x.js?token=secret');
    documents.issued(elsewhere, false);
    fail(elsewhere);
    // A navigation that fails before committing is the attempted document,
    // and leaves nothing pending.
    const refused = failing('/third', 'net::ERR_ABORTED', 'document');
    documents.issued(refused, true);
    fail(refused);
    const after = failing('/api/after', 'net::ERR_FAILED', 'fetch');
    documents.issued(after, false);
    fail(after);
    expect(
      log.snapshot().records.map(({ path, document }) => [path, document]),
    ).toEqual([
      ['/api/projects', 'previous'],
      ['/api/projects/late', 'previous'],
      ['/assets/CoreUpdateLaunchCheck-DDGWUae_.js', 'current'],
      ['other.invalid/x.js', 'current'],
      ['/third', 'current'],
      ['/api/after', 'current'],
    ]);
    expect(log.snapshot().records[2]).toEqual({
      path: '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
      errorText: 'net::ERR_ABORTED',
      resourceType: 'script',
      failedAt: 3_000,
      document: 'current',
    });
    expect(log.snapshot().records[0].failedAt).toBe(2_000);
    expect(JSON.stringify(log.snapshot())).not.toContain('secret');
    // A request the tracker never saw is not guessed.
    log.failed(failing('/unseen'));
    expect(log.snapshot().records.at(-1)?.document).toBe('unknown');
  });

  it('is bounded per attempt and starts empty after a reset', () => {
    const log = createFailedRequestLog(
      origin,
      createDocumentTracker(),
      () => 0,
    );
    for (let index = 0; index < MAX_FAILED_REQUESTS + 3; index++)
      log.failed(failing(`/assets/c${index}.js`));
    expect(log.snapshot().records).toHaveLength(MAX_FAILED_REQUESTS);
    expect(log.snapshot().omitted).toBe(3);
    log.reset();
    expect(log.snapshot()).toEqual({ records: [], omitted: 0 });
  });
});

describe('report-only change record', () => {
  it('diffs control names as multisets', () => {
    expect(
      diffControlNames(['Back', 'Send', 'Send'], ['Retry', 'Back', 'Send']),
    ).toEqual({
      changed: true,
      added: ['Retry'],
      removed: ['Send'],
      omitted: 0,
    });
    expect(diffControlNames(['A', 'B'], ['B', 'A']).changed).toBe(false);
  });

  it('summarises shifts and lists the worst ten screens', () => {
    const summary = summariseLayoutShifts({
      supported: true,
      dropped: 0,
      entries: [
        { startTime: 1, value: 0.02, sources: ['div.app'] },
        {
          startTime: 2,
          value: 0.15354,
          sources: ['div.app.app--with-sidebar'],
        },
      ],
    });
    expect(summary).toEqual({
      supported: true,
      count: 2,
      score: 0.1735,
      largest: { value: 0.1535, sources: ['div.app.app--with-sidebar'] },
      dropped: 0,
    });
    const still = summariseLayoutShifts({
      supported: true,
      dropped: 0,
      entries: [],
    });
    const rows = Array.from({ length: 12 }, (_, index) => ({
      name: `screen-${index}`,
      layoutShift: { ...summary, score: index / 100, count: 1 },
    }));
    const table = formatLayoutShiftTable([
      ...rows,
      { name: 'still', layoutShift: still },
      {
        name: 'changed-controls',
        layoutShift: still,
        controlsAfterPhoto: diffControlNames([], ['Retry']),
      },
      { name: 'unmeasured' },
    ]);
    expect(table[0]).toBe(
      'Gallery layout shift from ready to after the audit (report only; nothing fails on it): 14 of 15 screen(s) measured, 13 moved or changed controls.',
    );
    expect(table).toHaveLength(12);
    expect(table[2]).toContain('screen-11');
    expect(table.join('\n')).not.toContain('screen-1 ');
  });
});

describe('test-only fault injection', () => {
  const faults = JSON.stringify([
    {
      screen: 'home',
      kind: 'abort-chunk',
      chunk: 'CoreUpdateLaunchCheck',
      attempts: [1],
    },
  ]);

  it('is off unless asked for', () => {
    expect(readGalleryFaults({}, null)).toEqual([]);
  });

  it('is refused on GitHub Actions and on a full capture', () => {
    expect(() =>
      readGalleryFaults(
        { STATION_E2E_GALLERY_FAULTS: faults, GITHUB_ACTIONS: 'true' },
        ['home'],
      ),
    ).toThrow(/refused on a GitHub Actions runner/);
    expect(() =>
      readGalleryFaults({ STATION_E2E_GALLERY_FAULTS: faults }, null),
    ).toThrow(/needs a targeted capture/);
  });

  it('accepts only well-formed faults on selected screens', () => {
    expect(
      readGalleryFaults({ STATION_E2E_GALLERY_FAULTS: faults }, ['home']),
    ).toEqual([
      {
        screen: 'home',
        kind: 'abort-chunk',
        chunk: 'CoreUpdateLaunchCheck',
        attempts: [1],
        when: 'load',
      },
    ]);
    for (const bad of [
      '{',
      '[]',
      '[{"screen":"other","kind":"fail-step","attempts":[1]}]',
      '[{"screen":"home","kind":"fail-step","attempts":[3]}]',
      '[{"screen":"home","kind":"nope","attempts":[1]}]',
      '[{"screen":"home","kind":"abort-chunk","chunk":"../x","attempts":[1]}]',
      '[{"screen":"home","kind":"abort-chunk","chunk":"X","attempts":[1],"when":"later"}]',
    ])
      expect(
        () => readGalleryFaults({ STATION_E2E_GALLERY_FAULTS: bad }, ['home']),
        bad,
      ).toThrow(/STATION_E2E_GALLERY_FAULTS/);
  });

  it('matches only the named chunk file', () => {
    expect(
      isChunkPath(
        '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
        'CoreUpdateLaunchCheck',
      ),
    ).toBe(true);
    expect(
      isChunkPath(
        '/assets/CoreUpdateLaunchCheckExtra-DDGWUae_.js',
        'CoreUpdateLaunchCheck',
      ),
    ).toBe(false);
    expect(
      isChunkPath(
        '/assets/CoreUpdateLaunchCheck-x-DDGWUae_.css',
        'CoreUpdateLaunchCheck',
      ),
    ).toBe(false);
  });
});
