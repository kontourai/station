import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { main } from '../promote-store-release.mjs';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const makeTempDir = trackTempDirs();
const repository = resolve(import.meta.dirname, '../..');
const sourceSha = 'a'.repeat(40);
const artifactSha = 'b'.repeat(64);
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const appleEnv = {
  APPLE_API_ISSUER_ID: 'fixture-issuer',
  APPLE_API_KEY_ID: 'fixture-key',
  APPLE_API_PRIVATE_KEY: keys.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString(),
};
const playEnv = { GOOGLE_PLAY_ACCESS_TOKEN: 'fixture-play-token' };

function authority() {
  return {
    kind: 'station.release-store-authority/v1',
    producerTag: 'v0.2.0-rc.1',
    sourceSha,
    version: '0.2.0',
    android: {
      packageName: 'io.kontourai.station',
      versionCode: 20001,
      aabSha256: artifactSha,
      providerBundleSha256: artifactSha,
      sourceTrack: 'internal',
    },
    ios: {
      bundleId: 'io.kontourai.station',
      appId: 'app-1',
      buildId: 'build-1',
      buildNumber: '20001',
      ipaSha256: artifactSha,
      upload: {
        deliveryMode: 'uploaded',
        sourceSha,
        ipaSha256: artifactSha,
        buildId: 'build-1',
        acknowledged: true,
      },
    },
  };
}

function fixture(value: unknown = authority()) {
  const dir = makeTempDir('station-store-promotion-');
  const input = join(dir, 'authority.json');
  const output = join(dir, 'result.json');
  writeFileSync(input, JSON.stringify(value));
  return {
    dir,
    input,
    output,
    args: (platform: string, mode = 'plan') => [
      platform,
      '--authority',
      input,
      '--output',
      output,
      '--mode',
      mode,
    ],
  };
}

type Call = { method: string; path: string; body: any };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const response = (value: any, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status });

function pendingBeforeEffect(path: string, operation: string | undefined) {
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  expect(persisted.state).toBe('ATTEMPTED');
  expect(persisted.operations.at(-1)).toMatchObject({ state: 'ATTEMPTED' });
  if (operation) expect(persisted.operations.at(-1).operation).toBe(operation);
}

function playProvider(
  output: string,
  options: {
    source?: any;
    target?: any;
    bundleDigest?: string;
    commitLoss?: boolean;
    cleanupLoss?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const prior = {
    name: 'prior release',
    versionCodes: ['10099'],
    status: 'completed',
    releaseNotes: [{ language: 'en-US', text: 'Retain these notes' }],
    inAppUpdatePriority: 2,
  };
  let current = copy(
    options.target ?? { track: 'production', releases: [prior] },
  );
  let sequence = 0;
  const edits = new Map<string, any>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/androidpublisher/v3', '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    expect(url.origin).toBe('https://androidpublisher.googleapis.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer fixture-play-token',
    );
    if (method !== 'GET') pendingBeforeEffect(output, undefined);
    if (method === 'POST' && path.endsWith('/edits')) {
      const id = `edit-${++sequence}`;
      edits.set(id, copy(current));
      return response({ id });
    }
    const editId = /\/edits\/(edit-[0-9]+)/.exec(path)?.[1];
    if (method === 'DELETE' && editId) {
      if (options.cleanupLoss) throw new Error('private provider diagnostic');
      edits.delete(editId);
      return response(null, 204);
    }
    if (method === 'GET' && path.endsWith('/tracks/internal'))
      return response(
        options.source ?? {
          track: 'internal',
          releases: [
            { name: '0.2.0', versionCodes: ['20001'], status: 'completed' },
          ],
        },
      );
    if (method === 'GET' && path.endsWith('/tracks/production'))
      return response(edits.get(editId ?? ''));
    if (method === 'GET' && path.endsWith('/bundles'))
      return response({
        bundles: [
          { versionCode: 20001, sha256: options.bundleDigest ?? artifactSha },
        ],
      });
    if (method === 'PUT' && path.endsWith('/tracks/production')) {
      edits.set(editId ?? '', copy(body));
      return response(body);
    }
    if (method === 'POST' && path.endsWith(':commit')) {
      current = copy(edits.get(editId ?? ''));
      edits.delete(editId ?? '');
      if (options.commitLoss)
        throw new Error('fixture-play-token must never be recorded');
      return response({ id: editId });
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  };
  return { calls, fetchImpl, prior, current: () => current };
}

function appleProvider(
  output: string,
  options: {
    wrongBuild?: boolean;
    releaseType?: string;
    submitted?: boolean;
    submitLoss?: boolean;
    unrelatedReview?: boolean;
    missingVersion?: boolean;
    modernState?: string;
  } = {},
) {
  const calls: Call[] = [];
  let linked = options.submitted ? 'build-1' : null;
  let appState = options.submitted
    ? 'WAITING_FOR_REVIEW'
    : 'PREPARE_FOR_SUBMISSION';
  let review: any = options.unrelatedReview
    ? {
        type: 'reviewSubmissions',
        id: 'foreign-review',
        attributes: { state: 'READY_FOR_REVIEW' },
      }
    : null;
  let items: any[] = options.unrelatedReview
    ? [
        {
          type: 'reviewSubmissionItems',
          id: 'foreign-item',
          relationships: {
            appStoreVersion: {
              data: { type: 'appStoreVersions', id: 'foreign-version' },
            },
          },
        },
      ]
    : [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    expect(url.origin).toBe('https://api.appstoreconnect.apple.com');
    expect(
      new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '),
    ).toBe(true);
    if (method !== 'GET') pendingBeforeEffect(output, undefined);
    if (method === 'GET' && path === '/v1/apps/app-1')
      return response({
        data: {
          type: 'apps',
          id: 'app-1',
          attributes: { bundleId: 'io.kontourai.station' },
        },
      });
    if (method === 'GET' && path === '/v1/builds/build-1')
      return response({
        data: {
          type: 'builds',
          id: 'build-1',
          attributes: {
            version: options.wrongBuild ? '20002' : '20001',
            processingState: 'VALID',
          },
          relationships: {
            app: { data: { type: 'apps', id: 'app-1' } },
            preReleaseVersion: {
              data: { type: 'preReleaseVersions', id: 'train-1' },
            },
          },
        },
        included: [
          {
            type: 'preReleaseVersions',
            id: 'train-1',
            attributes: { version: '0.2.0', platform: 'IOS' },
          },
        ],
      });
    if (method === 'GET' && path === '/v1/apps/app-1/appStoreVersions')
      return response({
        data: options.missingVersion
          ? []
          : [
              {
                type: 'appStoreVersions',
                id: 'version-1',
                attributes: {
                  versionString: '0.2.0',
                  platform: 'IOS',
                  releaseType: options.releaseType ?? 'MANUAL',
                  appStoreState: appState,
                  ...(options.modernState
                    ? { appVersionState: options.modernState }
                    : {}),
                },
                relationships: {
                  build: {
                    data: linked ? { type: 'builds', id: linked } : null,
                  },
                },
              },
            ],
      });
    if (method === 'GET' && path === '/v1/apps/app-1/reviewSubmissions')
      return response({ data: review ? [review] : [] });
    if (method === 'GET' && /\/reviewSubmissions\/[^/]+\/items$/.test(path))
      return response({ data: items });
    if (
      method === 'PATCH' &&
      path === '/v1/appStoreVersions/version-1/relationships/build'
    ) {
      expect(body).toEqual({ data: { type: 'builds', id: 'build-1' } });
      linked = body.data.id;
      return response(null, 204);
    }
    if (method === 'POST' && path === '/v1/reviewSubmissions') {
      expect(body.data.relationships.app.data).toEqual({
        type: 'apps',
        id: 'app-1',
      });
      review = {
        type: 'reviewSubmissions',
        id: 'review-1',
        attributes: { state: 'READY_FOR_REVIEW' },
      };
      return response({ data: review }, 201);
    }
    if (method === 'POST' && path === '/v1/reviewSubmissionItems') {
      expect(body.data.relationships).toEqual({
        reviewSubmission: {
          data: { type: 'reviewSubmissions', id: 'review-1' },
        },
        appStoreVersion: {
          data: { type: 'appStoreVersions', id: 'version-1' },
        },
      });
      items = [{ ...body.data, id: 'item-1' }];
      return response({ data: items[0] }, 201);
    }
    if (method === 'PATCH' && path === '/v1/reviewSubmissions/review-1') {
      expect(body.data.attributes).toEqual({ submitted: true });
      review.attributes.state = 'WAITING_FOR_REVIEW';
      appState = 'WAITING_FOR_REVIEW';
      if (options.submitLoss)
        throw new Error('untrusted provider error contains private token');
      return response({ data: review });
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  };
  return { calls, fetchImpl };
}

describe('authenticated RC store authority command boundary', () => {
  test.each([
    [
      'final tag',
      (value: ReturnType<typeof authority>) => {
        value.producerTag = 'v0.2.0';
      },
    ],
    [
      'final store slot',
      (value: ReturnType<typeof authority>) => {
        value.android.versionCode = 20099;
      },
    ],
    [
      'different bundle digest',
      (value: ReturnType<typeof authority>) => {
        value.android.providerBundleSha256 = 'c'.repeat(64);
      },
    ],
    [
      'reconciled Apple build',
      (value: ReturnType<typeof authority>) => {
        value.ios.upload.deliveryMode = 'reconciled';
      },
    ],
    [
      'unacknowledged Apple upload',
      (value: ReturnType<typeof authority>) => {
        value.ios.upload.acknowledged = false;
      },
    ],
    [
      'another Apple source',
      (value: ReturnType<typeof authority>) => {
        value.ios.upload.sourceSha = 'c'.repeat(40);
      },
    ],
  ])(
    'refuses %s before credential access, journal creation or provider calls',
    async (_label, change) => {
      const value = authority();
      change(value);
      const f = fixture(value);
      let requested = false;
      await expect(
        main(f.args('android'), {}, async () => {
          requested = true;
          throw new Error();
        }),
      ).rejects.toThrow();
      expect(requested).toBe(false);
      expect(existsSync(f.output)).toBe(false);
    },
  );

  test('the real CLI refuses an invalid RC identity before creating a result', {
    timeout: FIXTURE_TEST_TIMEOUT_MS,
  }, async () => {
    const value = authority();
    value.producerTag = 'v0.2.0';
    const f = fixture(value);
    const result = await runBoundedFixture(
      process.execPath,
      [
        join(repository, 'scripts/promote-store-release.mjs'),
        ...f.args('android'),
      ],
      { cwd: f.dir, env: {} },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Store promotion refused:');
    expect(existsSync(f.output)).toBe(false);
  });
});

describe('same-build Google Play promotion', () => {
  test('plan deletes its temporary edit and never updates or commits a track', async () => {
    const f = fixture();
    const provider = playProvider(f.output);
    const result = await main(f.args('android'), playEnv, provider.fetchImpl);
    expect(result.state).toBe('PLANNED');
    expect(
      provider.calls
        .filter((call) => call.method !== 'GET')
        .map((call) => call.method),
    ).toEqual(['POST', 'DELETE']);
    expect(result.plan.track.releases[0]).toEqual(provider.prior);
    expect(result.plan.track.releases[1]).toEqual({
      name: '0.2.0',
      versionCodes: ['20001'],
      status: 'inProgress',
      userFraction: 0.1,
    });
  });

  test('apply preserves unrelated releases and promotes the RC slot without upload or rebuilding', async () => {
    const f = fixture();
    const provider = playProvider(f.output);
    const result = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('VERIFIED');
    expect(result.publication).toBe('NOT_VERIFIED');
    expect(provider.current().releases[0]).toEqual(provider.prior);
    expect(provider.current().releases[1].versionCodes).toEqual(['20001']);
    expect(
      provider.calls.filter((call) => call.path.endsWith(':commit')),
    ).toHaveLength(1);
    expect(provider.calls.some((call) => call.path.includes('/upload'))).toBe(
      false,
    );
    expect(
      result.operations.every(
        (operation: any) => operation.state === 'ACKNOWLEDGED',
      ),
    ).toBe(true);
  });

  test.each([
    ['another bundle digest', { bundleDigest: 'c'.repeat(64) }],
    [
      'another source build',
      {
        source: {
          track: 'internal',
          releases: [{ versionCodes: ['20002'], status: 'completed' }],
        },
      },
    ],
    [
      'an unrelated rollout',
      {
        target: {
          track: 'production',
          releases: [
            {
              versionCodes: ['19000'],
              status: 'inProgress',
              userFraction: 0.5,
            },
          ],
        },
      },
    ],
    [
      'a newer target build',
      {
        target: {
          track: 'production',
          releases: [{ versionCodes: ['20100'], status: 'completed' }],
        },
      },
    ],
  ])('refuses %s before updating any track', async (_label, options) => {
    const f = fixture();
    const provider = playProvider(f.output, options);
    const result = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('REFUSED');
    expect(
      provider.calls.some(
        (call) => call.method === 'PUT' || call.path.endsWith(':commit'),
      ),
    ).toBe(false);
    expect(provider.calls.at(-1)?.method).toBe('DELETE');
  });

  test('lost commit reply remains unknown, blocks write replay, then reconciles exact readback', async () => {
    const f = fixture();
    const provider = playProvider(f.output, { commitLoss: true });
    const result = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('UNKNOWN');
    expect(readFileSync(f.output, 'utf8')).not.toContain('fixture-play-token');
    const count = provider.calls.length;
    await expect(
      main(f.args('android', 'apply'), playEnv, provider.fetchImpl),
    ).rejects.toThrow('result already exists');
    expect(provider.calls).toHaveLength(count);
    const reconciled = await main(
      f.args('android', 'reconcile'),
      playEnv,
      provider.fetchImpl,
    );
    expect(reconciled.state).toBe('VERIFIED');
    expect(
      provider.calls.filter((call) => call.path.endsWith(':commit')),
    ).toHaveLength(1);
    expect(
      reconciled.operations.find(
        (operation: any) => operation.operation === 'commit-edit',
      ).state,
    ).toBe('UNKNOWN');
  });

  test('unconfirmed edit cleanup prevents a clean plan result', async () => {
    const f = fixture();
    const provider = playProvider(f.output, { cleanupLoss: true });
    const result = await main(f.args('android'), playEnv, provider.fetchImpl);
    expect(result.state).toBe('UNKNOWN');
    expect(result.operations.at(-1)).toMatchObject({
      operation: 'prepare-cleanup',
      state: 'UNKNOWN',
    });
    expect(readFileSync(f.output, 'utf8')).not.toContain(
      'private provider diagnostic',
    );
  });

  test('already selected exact rollout is an observed no-op', async () => {
    const f = fixture();
    const provider = playProvider(f.output, {
      target: {
        track: 'production',
        releases: [
          {
            name: '0.2.0',
            versionCodes: ['20001'],
            status: 'inProgress',
            userFraction: 0.1,
          },
        ],
      },
    });
    const result = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('NOOP');
    expect(
      provider.calls.some(
        (call) => call.method === 'PUT' || call.path.endsWith(':commit'),
      ),
    ).toBe(false);
  });

  test('stage observation hashes the real AAB and admits authority only after matching provider readback and cleanup', async () => {
    const f = fixture();
    const aab = join(f.dir, 'candidate.aab');
    writeFileSync(aab, 'candidate AAB bytes');
    const expected = createHash('sha256')
      .update('candidate AAB bytes')
      .digest('hex');
    const provider = playProvider(`${f.output}.observation.json`, {
      bundleDigest: expected,
    });
    const result = await main(
      [
        'observe-android',
        '--producer-tag',
        'v0.2.0-rc.1',
        '--source-sha',
        sourceSha,
        '--aab',
        aab,
        '--output',
        f.output,
      ],
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('VERIFIED');
    const observed = JSON.parse(readFileSync(f.output, 'utf8'));
    expect(observed.android).toEqual({
      packageName: 'io.kontourai.station',
      versionCode: 20001,
      sourceTrack: 'internal',
      aabSha256: expected,
      providerBundleSha256: expected,
    });
    expect(
      provider.calls.some(
        (call) => call.method === 'PUT' || call.path.endsWith(':commit'),
      ),
    ).toBe(false);
  });

  test('stage observation with unknown cleanup emits no reusable authority file', async () => {
    const f = fixture();
    const aab = join(f.dir, 'candidate.aab');
    writeFileSync(aab, 'candidate AAB bytes');
    const expected = createHash('sha256')
      .update('candidate AAB bytes')
      .digest('hex');
    const provider = playProvider(`${f.output}.observation.json`, {
      bundleDigest: expected,
      cleanupLoss: true,
    });
    const result = await main(
      [
        'observe-android',
        '--producer-tag',
        'v0.2.0-rc.1',
        '--source-sha',
        sourceSha,
        '--aab',
        aab,
        '--output',
        f.output,
      ],
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('UNKNOWN');
    expect(existsSync(f.output)).toBe(false);
  });
});

describe('exact uploaded Apple build submission', () => {
  test('plan reads the selected build but performs no App Store mutation', async () => {
    const f = fixture();
    const provider = appleProvider(f.output);
    const result = await main(f.args('ios'), appleEnv, provider.fetchImpl);
    expect(result.state).toBe('PLANNED');
    expect(result.plan).toEqual({
      versionId: 'version-1',
      buildId: 'build-1',
      review: 'submit',
      releaseType: 'MANUAL',
    });
    expect(provider.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('selects the exact RC build and uses App Review submissions, never Beta review or automatic release', async () => {
    const f = fixture();
    const provider = appleProvider(f.output);
    const result = await main(
      f.args('ios', 'apply'),
      appleEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('VERIFIED');
    expect(result.providerState).toBe('WAITING_FOR_REVIEW');
    expect(result.publication).toBe('NOT_VERIFIED');
    expect(
      provider.calls
        .filter((call) => call.method !== 'GET')
        .map((call) => call.path),
    ).toEqual([
      '/v1/appStoreVersions/version-1/relationships/build',
      '/v1/reviewSubmissions',
      '/v1/reviewSubmissionItems',
      '/v1/reviewSubmissions/review-1',
    ]);
    expect(
      provider.calls.some((call) => call.path.toLowerCase().includes('beta')),
    ).toBe(false);
  });

  test.each([
    ['wrong build slot', { wrongBuild: true }],
    ['automatic release authority', { releaseType: 'AFTER_APPROVAL' }],
    ['another active submission', { unrelatedReview: true }],
    ['missing owner-prepared metadata', { missingVersion: true }],
  ])('refuses %s before changing Apple state', async (_label, options) => {
    const f = fixture();
    const provider = appleProvider(f.output, options);
    const result = await main(
      f.args('ios', 'apply'),
      appleEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('REFUSED');
    expect(provider.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('an already submitted version selecting the exact build is an observed no-op', async () => {
    const f = fixture();
    const provider = appleProvider(f.output, { submitted: true });
    const result = await main(
      f.args('ios', 'apply'),
      appleEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('NOOP');
    expect(provider.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('submission reply loss preserves unknown until exact version/build readback, without repeating mutations', async () => {
    const f = fixture();
    const provider = appleProvider(f.output, { submitLoss: true });
    const result = await main(
      f.args('ios', 'apply'),
      appleEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('UNKNOWN');
    expect(readFileSync(f.output, 'utf8')).not.toContain('private token');
    const count = provider.calls.length;
    const reconciled = await main(
      f.args('ios', 'reconcile'),
      appleEnv,
      provider.fetchImpl,
    );
    expect(reconciled.state).toBe('VERIFIED');
    expect(
      provider.calls.slice(count).every((call) => call.method === 'GET'),
    ).toBe(true);
    expect(
      provider.calls.filter(
        (call) =>
          call.method === 'PATCH' &&
          call.path === '/v1/reviewSubmissions/review-1',
      ),
    ).toHaveLength(1);
  });
});

describe('promotion review regression controls', () => {
  test.each([
    { ...authority(), sourceSha: [sourceSha] },
    {
      ...authority(),
      android: { ...authority().android, sourceTrack: ['internal'] },
    },
    {
      ...authority(),
      android: { ...authority().android, sourceTrack: ['production'] },
    },
  ])(
    'malformed JSON primitives fail before credentials, journal or requests: %o',
    async (value) => {
      const f = fixture(value);
      const credentials = Object.defineProperty(
        {},
        'GOOGLE_PLAY_ACCESS_TOKEN',
        {
          get() {
            throw new Error('credential access');
          },
        },
      );
      let calls = 0;
      await expect(
        main(f.args('android'), credentials, async () => {
          calls++;
          throw new Error('provider request');
        }),
      ).rejects.toThrow('Store promotion refused:');
      expect(calls).toBe(0);
      expect(existsSync(f.output)).toBe(false);
    },
  );

  test('completed candidate rollout is a no-op instead of returning to 10 percent', async () => {
    const f = fixture();
    const target = {
      track: 'production',
      releases: [{ versionCodes: ['20001'], status: 'completed' }],
    };
    const provider = playProvider(f.output, { target });
    const result = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('NOOP');
    expect(provider.current()).toEqual(target);
    expect(
      provider.calls.some(
        (call) => call.method === 'PUT' || call.path.endsWith(':commit'),
      ),
    ).toBe(false);
  });

  test('existing rollout cannot shrink to a lower requested fraction', async () => {
    const f = fixture();
    const provider = playProvider(f.output, {
      target: {
        track: 'production',
        releases: [
          { versionCodes: ['20001'], status: 'inProgress', userFraction: 0.5 },
        ],
      },
    });
    const result = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('REFUSED');
    expect(result.failure).toContain('cannot be reduced');
    expect(
      provider.calls.some(
        (call) => call.method === 'PUT' || call.path.endsWith(':commit'),
      ),
    ).toBe(false);
  });

  test('first production launch requires explicit full rollout', async () => {
    const f = fixture();
    const provider = playProvider(f.output, {
      target: { track: 'production', releases: [] },
    });
    const refused = await main(
      f.args('android', 'apply'),
      playEnv,
      provider.fetchImpl,
    );
    expect(refused.state).toBe('REFUSED');
    expect(refused.failure).toContain('first production publication');
    expect(provider.calls.some((call) => call.method === 'PUT')).toBe(false);
    const full = fixture();
    const fullProvider = playProvider(full.output, {
      target: { track: 'production', releases: [] },
    });
    const launched = await main(
      [...full.args('android', 'apply'), '--fraction', '1'],
      playEnv,
      fullProvider.fetchImpl,
    );
    expect(launched.state).toBe('VERIFIED');
    expect(fullProvider.current().releases).toEqual([
      { name: '0.2.0', versionCodes: ['20001'], status: 'completed' },
    ]);
  });

  test('country-targeted completion refuses before expanding geography implicitly', async () => {
    const f = fixture();
    const provider = playProvider(f.output, {
      target: {
        track: 'production',
        releases: [
          {
            versionCodes: ['20001'],
            status: 'inProgress',
            userFraction: 0.5,
            countryTargeting: { countries: ['US'] },
          },
        ],
      },
    });
    const result = await main(
      [...f.args('android', 'apply'), '--fraction', '1'],
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).toBe('REFUSED');
    expect(result.failure).toContain('geography disposition');
    expect(provider.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  test('reconcile cannot borrow an old production track from a modified matching journal', async () => {
    const f = fixture();
    const provider = playProvider(f.output, { commitLoss: true });
    expect(
      (await main(f.args('android', 'apply'), playEnv, provider.fetchImpl))
        .state,
    ).toBe('UNKNOWN');
    const journal = JSON.parse(readFileSync(f.output, 'utf8'));
    journal.plan.track = { track: 'production', releases: [provider.prior] };
    writeFileSync(f.output, JSON.stringify(journal));
    const count = provider.calls.length;
    const result = await main(
      f.args('android', 'reconcile'),
      playEnv,
      provider.fetchImpl,
    );
    expect(result.state).not.toBe('VERIFIED');
    expect(result.failure).toContain('frozen RC');
    expect(provider.calls).toHaveLength(count);
  });

  test.each(['PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION'])(
    'already submitted exact Apple build in modern %s is a no-op',
    async (modernState) => {
      const f = fixture();
      const provider = appleProvider(f.output, {
        submitted: true,
        modernState,
      });
      const result = await main(
        f.args('ios', 'apply'),
        appleEnv,
        provider.fetchImpl,
      );
      expect(result.state).toBe('NOOP');
      expect(provider.calls.every((call) => call.method === 'GET')).toBe(true);
    },
  );
});
