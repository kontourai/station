import { describe, expect, it } from 'vitest';
import {
  type AppErrorObservation,
  chunkLoadFailed,
  createFailedRequestLog,
  diffControlNames,
  formatAppErrorIdentity,
  formatControlChangeTable,
  isChunkPath,
  MAX_FAILED_REQUESTS,
  measureControlMovement,
  readGalleryFaults,
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

const request = (
  path: string,
  document: 'current' | 'previous',
  resourceType = 'script',
  errorText = 'net::ERR_ABORTED',
  failedAt = 1,
  // What createFailedRequestLog records for a same-origin path.
  appAsset = path.startsWith('/assets/'),
) => ({ path, appAsset, document, resourceType, errorText, failedAt });

describe('app error identity', () => {
  it('names the surfaces and the live document failed chunks, hashes masked, on one line', () => {
    const identity = formatAppErrorIdentity(
      observation({
        surfaces: { 'extension-registry-toast': 1, 'lazy-boundary-row': 2 },
        failedRequests: [
          request('/api/orchestration/events', 'previous', 'fetch'),
          request('/assets/ServerOlderLaunchCheck-1bLuJgi9.js', 'current'),
          request('/assets/CoreUpdateLaunchCheck-DDGWUae_.js', 'current'),
          request('/assets/CoreUpdateLaunchCheck-DDGWUae_.js', 'current'),
          request('/assets/Stale-abcdefgh.js', 'previous'),
          request('/api/projects', 'current', 'fetch'),
        ],
      }),
    );
    expect(identity).toBe(
      'app-error-surface: extension-registry-toast, lazy-boundary-row; failed chunk requests: /assets/CoreUpdateLaunchCheck-<hash>.js, /assets/ServerOlderLaunchCheck-<hash>.js',
    );
    expect(identity).not.toContain('\n');
  });

  // Run 2026-11-16: one screen, one fault, two captures in one build gave
  // different identities when they carried teardown requests and error text.
  it('is equal for two captures of one failure that differ in teardown requests, error text, phase, counts and step error', () => {
    const first = observation({
      phase: 'before capture',
      surfaces: { 'lazy-boundary-row': 1 },
      failedRequests: [
        request('/api/orchestration/events', 'previous', 'fetch'),
        request('/api/models', 'previous', 'fetch'),
        request(
          '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
          'current',
          'script',
          'net::ERR_FAILED',
          5,
        ),
      ],
    });
    const second = observation({
      phase: 'after capture',
      surfaces: { 'lazy-boundary-row': 2 },
      stepError: 'locator.waitFor: Timeout 10000ms exceeded.',
      failedRequests: [
        request(
          '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
          'current',
          'script',
          'net::ERR_ABORTED',
          9,
        ),
        request('/api/projects/gallery-x', 'current', 'fetch'),
      ],
    });
    expect(formatAppErrorIdentity(first)).toBe(formatAppErrorIdentity(second));
  });

  it('never reads a surface without a failed chunk request like a failed download', () => {
    const renderError = observation({
      failedRequests: [
        request('/api/orchestration/events', 'previous', 'fetch'),
      ],
    });
    const download = observation({
      failedRequests: [
        request('/assets/CoreUpdateLaunchCheck-DDGWUae_.js', 'current'),
      ],
    });
    expect(formatAppErrorIdentity(renderError)).toBe(
      'app-error-surface: lazy-boundary-row; no failed chunk request',
    );
    expect(formatAppErrorIdentity(renderError)).not.toBe(
      formatAppErrorIdentity(download),
    );
    expect(chunkLoadFailed(renderError)).toBe(false);
    expect(chunkLoadFailed(download)).toBe(true);
    // A previous document's script is navigation teardown, not evidence.
    expect(
      chunkLoadFailed(
        observation({
          failedRequests: [request('/assets/A-abcdefgh.js', 'previous')],
        }),
      ),
    ).toBe(false);
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
    documents.responded(first, 200);
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
    documents.responded(next, 200);
    documents.committed();
    fail(late); // after it
    const chunk = failing('/assets/CoreUpdateLaunchCheck-DDGWUae_.js?v=1#x');
    documents.issued(chunk, false);
    clock = 3_000;
    fail(chunk);
    // A history-API navigation commits no new document.
    documents.committed();
    // A cross-origin script of the live page is recorded, but it is not one
    // of the app's chunks.
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
      appAsset: true,
      errorText: 'net::ERR_ABORTED',
      resourceType: 'script',
      failedAt: 3_000,
      document: 'current',
    });
    expect(log.snapshot().records[0].failedAt).toBe(2_000);
    expect(JSON.stringify(log.snapshot())).not.toContain('secret');
    const crossOrigin = log
      .snapshot()
      .records.filter(({ path }) => path === 'other.invalid/x.js');
    expect(crossOrigin).toMatchObject([
      { document: 'current', resourceType: 'script', appAsset: false },
    ]);
    // So it neither earns a second capture nor enters the identity.
    const withCrossOrigin = observation({ failedRequests: crossOrigin });
    expect(chunkLoadFailed(withCrossOrigin)).toBe(false);
    expect(formatAppErrorIdentity(withCrossOrigin)).toBe(
      'app-error-surface: lazy-boundary-row; no failed chunk request',
    );
    // A request the tracker never saw is not guessed.
    log.failed(failing('/unseen'));
    expect(
      log.snapshot().records.find(({ path }) => path === '/unseen')?.document,
    ).toBe('unknown');
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
    // Navigation teardown cannot crowd out the chunk a retry depends on.
    for (let index = 0; index < MAX_FAILED_REQUESTS + 8; index++)
      log.failed(
        failing(`/api/teardown-${index}`, 'net::ERR_ABORTED', 'fetch'),
      );
    log.failed(failing('/assets/CoreUpdateLaunchCheck-DDGWUae_.js'));
    expect(
      log
        .snapshot()
        .records.some(
          ({ path }) => path === '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
        ),
    ).toBe(true);
    expect(log.snapshot().omitted).toBe(8);
  });

  it("only the app's own scripts are chunks: same origin as the page, under /assets/", () => {
    const documents = createDocumentTracker();
    const log = createFailedRequestLog(origin, documents, () => 0);
    for (const url of [
      `${origin}/assets/Chunk-abcdefgh.js`,
      `${origin}/vendor/Chunk-abcdefgh.js`,
      // Same host, another port or scheme: another origin.
      'http://localhost:5315/assets/Chunk-abcdefgh.js',
      'https://localhost:5314/assets/Chunk-abcdefgh.js',
      'http://cdn.invalid/assets/Chunk-abcdefgh.js',
    ])
      log.failed(failing(url));
    expect(
      log.snapshot().records.map(({ path, appAsset }) => [path, appAsset]),
    ).toEqual([
      ['/assets/Chunk-abcdefgh.js', true],
      ['/vendor/Chunk-abcdefgh.js', false],
      ['localhost:5315/assets/Chunk-abcdefgh.js', false],
      ['localhost:5314/assets/Chunk-abcdefgh.js', false],
      ['cdn.invalid/assets/Chunk-abcdefgh.js', false],
    ]);
    const live = log
      .snapshot()
      .records.map((record) => ({ ...record, document: 'current' as const }));
    expect(formatAppErrorIdentity(observation({ failedRequests: live }))).toBe(
      'app-error-surface: lazy-boundary-row; failed chunk requests: /assets/Chunk-<hash>.js',
    );
  });
});

describe('document tracker', () => {
  // Chromium's order, checked with Playwright: the outgoing document's
  // history change fires `framenavigated` while `page.goto` is pending and
  // before the navigation's response; the new document's comes after it.
  it("does not take the outgoing document's history change for the commit", () => {
    const documents = createDocumentTracker();
    const previous = failing('/previous', 'net::ERR_ABORTED', 'document');
    documents.issued(previous, true);
    documents.responded(previous, 200);
    documents.committed();
    const next = failing('/next', 'net::ERR_ABORTED', 'document');
    documents.issued(next, true);
    documents.committed(); // the outgoing document's replaceState
    // Issued by the outgoing document after its history change.
    const stray = failing('/assets/Stray-abcdefgh.js');
    documents.issued(stray, false);
    documents.responded(next, 200);
    documents.committed(); // the new document
    expect(documents.classify(stray)).toBe('previous');
    const live = failing('/assets/Live-abcdefgh.js');
    documents.issued(live, false);
    expect(documents.classify(live)).toBe('current');
  });

  it("keeps a live request current across the live document's own history change", () => {
    const documents = createDocumentTracker();
    const page = failing('/page', 'net::ERR_ABORTED', 'document');
    documents.issued(page, true);
    documents.responded(page, 200);
    documents.committed();
    const chunk = failing('/assets/Route-abcdefgh.js');
    documents.issued(chunk, false);
    documents.committed(); // the router's pushState while the chunk loads
    expect(documents.classify(chunk)).toBe('current');
  });

  it('follows a redirect to the navigation that commits, and drops one that fails', () => {
    const documents = createDocumentTracker();
    const redirect = failing('/r', 'net::ERR_ABORTED', 'document');
    documents.issued(redirect, true);
    documents.responded(redirect, 302);
    documents.committed(); // a history change before the redirect target
    const old = failing('/assets/Old-abcdefgh.js');
    documents.issued(old, false);
    const target = failing('/b', 'net::ERR_ABORTED', 'document');
    documents.issued(target, true);
    documents.responded(target, 200);
    documents.committed();
    expect(documents.classify(old)).toBe('previous');
    const refused = failing('/c', 'net::ERR_ABORTED', 'document');
    documents.issued(refused, true);
    documents.settled(refused, true);
    const live = failing('/assets/Live-abcdefgh.js');
    documents.issued(live, false);
    documents.committed(); // a history change after the failed navigation
    expect(documents.classify(live)).toBe('current');
  });
});

describe('report-only control record', () => {
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

  const box = (label: string, x: number, y: number) => ({
    label,
    disabled: false,
    x,
    y,
    width: 44,
    height: 44,
  });

  it('measures how far same-identity controls moved, paired by name and order', () => {
    const atPhoto = [
      box('Send', 10, 10),
      box('Send', 10, 60),
      box('Back', 0, 0),
    ];
    expect(measureControlMovement(atPhoto, atPhoto)).toEqual({
      compared: 3,
      moved: 0,
      largest: null,
    });
    // Sub-pixel noise is not a movement.
    expect(
      measureControlMovement(atPhoto, [
        box('Send', 10.3, 10),
        box('Send', 10, 60.4),
        box('Back', 0, 0),
      ]).moved,
    ).toBe(0);
    // The row pushed everything below it down by 80 px; Retry is new.
    expect(
      measureControlMovement(atPhoto, [
        box('Retry', 0, 0),
        box('Send', 10, 90),
        box('Send', 10, 140),
        box('Back', 0, 0),
      ]),
    ).toEqual({
      compared: 3,
      moved: 2,
      largest: { control: 'Send', dx: 0, dy: 80, distance: 80 },
    });
  });

  it('lists the ten screens that changed most and names the window', () => {
    const moved = (distance: number) => ({
      compared: 4,
      moved: 1,
      largest: { control: 'Send', dx: 0, dy: distance, distance },
    });
    const still = { compared: 4, moved: 0, largest: null };
    const rows = Array.from({ length: 12 }, (_, index) => ({
      name: `screen-${index}`,
      controlMovement: moved(index + 1),
    }));
    const table = formatControlChangeTable([
      ...rows,
      { name: 'still', controlMovement: still },
      {
        name: 'renamed',
        controlMovement: still,
        controlsAfterPhoto: diffControlNames([], ['Retry']),
      },
      { name: 'unmeasured' },
    ]);
    expect(table[0]).toBe(
      'Gallery controls between the photo (read just before the screenshot) and a second read when the audit ends; a change after that is not seen (report only; nothing fails on it): 14 of 15 screen(s) measured, 13 moved or changed controls.',
    );
    expect(table).toHaveLength(12);
    expect(formatControlChangeTable([], 1000)[0]).toContain(
      'a second read at least 1000 ms after the photo, after the audit',
    );
    expect(table[2]).toContain('screen-11');
    expect(table.join('\n')).not.toMatch(/screen-1 |still|renamed/);
  });
});

describe('test-only fault injection', () => {
  const faults = JSON.stringify([
    {
      screen: 'home',
      kind: 'chunk',
      chunk: 'CoreUpdateLaunchCheck',
      attempts: [1],
    },
  ]);
  const declared = ['home', 'agents'];

  it('is off unless asked for', () => {
    expect(readGalleryFaults({}, null, declared)).toEqual([]);
  });

  it('is refused on GitHub Actions and on a full capture', () => {
    expect(() =>
      readGalleryFaults(
        { STATION_E2E_GALLERY_FAULTS: faults, GITHUB_ACTIONS: 'true' },
        ['home'],
        declared,
      ),
    ).toThrow(/refused on a GitHub Actions runner/);
    expect(() =>
      readGalleryFaults({ STATION_E2E_GALLERY_FAULTS: faults }, null, declared),
    ).toThrow(/needs a targeted capture/);
    // --screens= naming every screen is a full capture too.
    expect(() =>
      readGalleryFaults(
        { STATION_E2E_GALLERY_FAULTS: faults },
        ['agents', 'home'],
        declared,
      ),
    ).toThrow(/leaves out at least one screen/);
  });

  it('accepts only well-formed faults on selected screens', () => {
    expect(
      readGalleryFaults(
        { STATION_E2E_GALLERY_FAULTS: faults },
        ['home'],
        declared,
      ),
    ).toEqual([
      {
        screen: 'home',
        kind: 'chunk',
        chunk: 'CoreUpdateLaunchCheck',
        attempts: [1],
        mode: 'abort',
        when: 'load',
      },
    ]);
    expect(
      readGalleryFaults(
        {
          STATION_E2E_GALLERY_FAULTS:
            '[{"screen":"home","kind":"move-after-photo","attempts":[1],"delayMs":600},{"screen":"home","kind":"fail-cleanup","attempts":[2]}]',
        },
        ['home'],
        declared,
      ),
    ).toEqual([
      { screen: 'home', kind: 'move-after-photo', attempts: [1], delayMs: 600 },
      { screen: 'home', kind: 'fail-cleanup', attempts: [2] },
    ]);
    for (const bad of [
      '{',
      '[]',
      '[{"screen":"other","kind":"fail-step","attempts":[1]}]',
      '[{"screen":"home","kind":"fail-step","attempts":[3]}]',
      '[{"screen":"home","kind":"nope","attempts":[1]}]',
      '[{"screen":"home","kind":"chunk","chunk":"../x","attempts":[1]}]',
      '[{"screen":"home","kind":"chunk","chunk":"X","attempts":[1],"when":"later"}]',
      '[{"screen":"home","kind":"chunk","chunk":"X","attempts":[1],"mode":"slow"}]',
      '[{"screen":"home","kind":"move-after-photo","attempts":[1],"delayMs":9000}]',
    ])
      expect(
        () =>
          readGalleryFaults(
            { STATION_E2E_GALLERY_FAULTS: bad },
            ['home'],
            declared,
          ),
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
