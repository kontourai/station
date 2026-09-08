import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  appStoreConnectErrorDetail,
  appStoreConnectRequest,
  assertCanonicalArtifactBuiltAt,
  attachInternalGroup,
  createAppStoreConnectJwt,
  receiptArtifactProvenance,
  selectAppResource,
  selectBuildResources,
  selectInternalGroup,
  selectProcessedBuildResource,
} from '../app-store-connect-receipt.mjs';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

describe('App Store Connect receipt authority', () => {
  test('keeps artifact build time distinct and canonical', () => {
    expect(() =>
      assertCanonicalArtifactBuiltAt('2026-08-30T12:00:00.000Z'),
    ).not.toThrow();
    expect(() =>
      assertCanonicalArtifactBuiltAt('2026-02-31T12:00:00.000Z'),
    ).toThrow(/artifact-built-at/);
  });
  test('attributes an artifact timestamp to the provider only after this run uploaded it', () => {
    const builtAt = '2026-08-30T12:00:00.000Z';
    expect(receiptArtifactProvenance('uploaded', builtAt)).toEqual({
      candidateArtifactBuiltAt: builtAt,
      providerArtifactBuiltAt: builtAt,
    });
    expect(receiptArtifactProvenance('reconciled', builtAt)).toEqual({
      candidateArtifactBuiltAt: builtAt,
      providerArtifactBuiltAt: null,
    });
  });
  test('creates a bounded ES256 App Store Connect token', () => {
    const token = createAppStoreConnectJwt({
      issuerId: 'issuer-id',
      keyId: 'KEY123',
      privateKey,
      now: Date.parse('2026-08-29T00:00:00Z'),
    });
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'issuer-id',
      iat: 1_787_961_600,
      exp: 1_787_962_200,
      aud: 'appstoreconnect-v1',
    });
    expect(
      verify(
        'SHA256',
        Buffer.from(`${header}.${claims}`),
        { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  test('selects exactly one matching app and one VALID build', () => {
    const app = selectAppResource(
      {
        data: [
          {
            type: 'apps',
            id: '6805330833',
            attributes: { bundleId: 'io.kontourai.station', name: 'Station' },
          },
        ],
      },
      'io.kontourai.station',
    );
    expect(app.id).toBe('6805330833');

    const build = selectProcessedBuildResource(
      {
        data: [
          {
            type: 'builds',
            id: 'build-id',
            attributes: { version: '10399', processingState: 'VALID' },
          },
        ],
      },
      '10399',
    );
    expect(build.id).toBe('build-id');
    expect(() =>
      selectProcessedBuildResource(
        {
          data: [
            {
              type: 'builds',
              id: 'build-id',
              attributes: { version: '10399', processingState: 'FAILED' },
            },
          ],
        },
        '10399',
      ),
    ).toThrow(/not VALID/);
  });

  test('fails closed on provider errors without echoing credentials', async () => {
    const response = new Response(
      JSON.stringify({ errors: [{ detail: 'The app is unavailable.' }] }),
      { status: 403 },
    );
    await expect(
      appStoreConnectRequest(
        '/v1/apps',
        { issuerId: 'issuer', keyId: 'key', privateKey },
        async () => response,
      ),
    ).rejects.toThrow('HTTP 403: The app is unavailable.');
  });

  test('rejects ambiguous or absent provider resources', () => {
    expect(() =>
      selectAppResource({ data: [] }, 'io.kontourai.station'),
    ).toThrow(/found 0/);
    expect(() =>
      selectProcessedBuildResource(
        {
          data: [
            { type: 'builds', attributes: { version: '10399' } },
            { type: 'builds', attributes: { version: '10399' } },
          ],
        },
        '10399',
      ),
    ).toThrow(/found 2/);
  });

  test('reconciliation allows absent or one build and refuses ambiguity', () => {
    expect(selectBuildResources({ data: [] }, '10399')).toEqual([]);
    expect(
      selectBuildResources(
        {
          data: [
            { type: 'builds', id: 'one', attributes: { version: '10399' } },
          ],
        },
        '10399',
      ),
    ).toHaveLength(1);
    expect(() =>
      selectBuildResources(
        {
          data: [
            { type: 'builds', attributes: { version: '10399' } },
            { type: 'builds', attributes: { version: '10399' } },
          ],
        },
        '10399',
      ),
    ).toThrow(/at most one/);
  });

  test('accepts only the exact internal group', () => {
    const payload = {
      data: [
        {
          type: 'betaGroups',
          id: 'group-id',
          attributes: {
            name: 'Station Beta Internal',
            isInternalGroup: true,
            hasAccessToAllBuilds: true,
          },
        },
      ],
    };
    expect(
      selectInternalGroup(payload, {
        appId: 'app-id',
        groupId: 'group-id',
        groupName: 'Station Beta Internal',
      }).id,
    ).toBe('group-id');
    expect(() =>
      selectInternalGroup(
        {
          data: [
            {
              type: 'betaGroups',
              id: 'group-id',
              attributes: {
                name: 'Station Beta Internal',
                isInternalGroup: false,
                hasAccessToAllBuilds: true,
              },
            },
          ],
        },
        {
          appId: 'app-id',
          groupId: 'group-id',
          groupName: 'Station Beta Internal',
        },
      ),
    ).toThrow(/exact internal group/);
  });

  test('fails closed when the group does not report hasAccessToAllBuilds as a boolean', () => {
    for (const hasAccessToAllBuilds of [undefined, null, 'true', 1]) {
      expect(() =>
        selectInternalGroup(
          {
            data: [
              {
                type: 'betaGroups',
                id: 'group-id',
                attributes: {
                  name: 'Station Beta Internal',
                  isInternalGroup: true,
                  ...(hasAccessToAllBuilds === undefined
                    ? {}
                    : { hasAccessToAllBuilds }),
                },
              },
            ],
          },
          {
            appId: 'app-id',
            groupId: 'group-id',
            groupName: 'Station Beta Internal',
          },
        ),
      ).toThrow(/hasAccessToAllBuilds as a boolean/);
    }
  });
});

describe('appStoreConnectErrorDetail', () => {
  test('names the provider errors from a body or its text, bounded and in order', () => {
    const body = {
      errors: [
        { code: 'STATE_ERROR', detail: 'Export compliance is missing.' },
        { title: 'Build not eligible' },
        { code: 'ENTITY_ERROR' },
        { detail: 'a fourth error that is dropped' },
      ],
    };
    expect(appStoreConnectErrorDetail(body)).toBe(
      'Export compliance is missing.; Build not eligible; ENTITY_ERROR',
    );
    expect(appStoreConnectErrorDetail(JSON.stringify(body))).toBe(
      'Export compliance is missing.; Build not eligible; ENTITY_ERROR',
    );
    expect(
      appStoreConnectErrorDetail({ errors: [{ detail: 'x'.repeat(400) }] }),
    ).toHaveLength(300);
  });
  test('is empty for non-JSON, non-error, and malformed payloads', () => {
    expect(appStoreConnectErrorDetail('<html>')).toBe('');
    expect(appStoreConnectErrorDetail({ data: [] })).toBe('');
    expect(appStoreConnectErrorDetail({ errors: [{ detail: 7 }, null] })).toBe(
      '',
    );
    expect(appStoreConnectErrorDetail(undefined)).toBe('');
  });
  test('the beta-group assignment failure carries the provider detail (HTTP 422)', async () => {
    const group = {
      data: [
        {
          type: 'betaGroups',
          id: 'group-1',
          attributes: {
            name: 'Station Nightly Internal',
            isInternalGroup: true,
            hasAccessToAllBuilds: false,
          },
          relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
        },
      ],
    };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/v1/betaGroups?'))
        return new Response(JSON.stringify(group), { status: 200 });
      return new Response(
        JSON.stringify({
          errors: [
            { code: 'STATE_ERROR', detail: 'Export compliance is missing.' },
          ],
        }),
        { status: 422 },
      );
    });
    try {
      await expect(
        attachInternalGroup(
          [
            '--app-id',
            'app-1',
            '--build-id',
            'build-1',
            '--group-id',
            'group-1',
            '--group-name',
            'Station Nightly Internal',
            '--output',
            join(tmpdir(), 'unused.json'),
          ],
          {
            APPLE_API_ISSUER_ID: 'issuer',
            APPLE_API_KEY_ID: 'key',
            APPLE_API_PRIVATE_KEY: privateKey,
          },
        ),
      ).rejects.toThrow(
        'beta-group assignment returned HTTP 422: Export compliance is missing.',
      );
      expect(calls).toEqual([
        'GET /v1/betaGroups',
        'POST /v1/betaGroups/group-1/relationships/builds',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('attachInternalGroup membership derivation (#1777)', () => {
  const env = {
    APPLE_API_ISSUER_ID: 'issuer',
    APPLE_API_KEY_ID: 'key',
    APPLE_API_PRIVATE_KEY: privateKey,
  };
  const groupPayload = (hasAccessToAllBuilds: unknown) => ({
    data: [
      {
        type: 'betaGroups',
        id: 'group-1',
        attributes: {
          name: 'Station Nightly Internal',
          isInternalGroup: true,
          ...(hasAccessToAllBuilds === undefined
            ? {}
            : { hasAccessToAllBuilds }),
        },
      },
    ],
  });
  const members = (ids: string[]) => ({
    data: ids.map((id) => ({ type: 'builds', id })),
  });
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  /**
   * A stubbed provider with a request log and a fake clock. `sleep` advances
   * the clock instead of waiting, so the bounded wait is observable by the
   * number of readback polls rather than by wall time.
   */
  function stubProvider(handlers: {
    group: unknown;
    readback: () => Response;
    post?: () => Response;
  }) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname === '/v1/betaGroups')
        return jsonResponse(handlers.group);
      if (
        method === 'GET' &&
        url.pathname === '/v1/betaGroups/group-1/relationships/builds'
      )
        return handlers.readback();
      if (
        method === 'POST' &&
        url.pathname === '/v1/betaGroups/group-1/relationships/builds' &&
        handlers.post
      )
        return handlers.post();
      throw new Error(`unexpected provider request ${method} ${url.pathname}`);
    });
    let clock = 1_000_000;
    return {
      calls,
      hooks: {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      },
    };
  }

  function run(
    output: string,
    hooks: { now: () => number; sleep: (ms: number) => Promise<void> },
    extraArgv: string[] = [],
  ) {
    return attachInternalGroup(
      [
        '--app-id',
        'app-1',
        '--build-id',
        'build-1',
        '--group-id',
        'group-1',
        '--group-name',
        'Station Nightly Internal',
        '--output',
        output,
        ...extraArgv,
      ],
      env,
      hooks,
    );
  }

  const receiptPath = () =>
    join(mkdtempSync(join(tmpdir(), 'asc-membership-')), 'receipt.json');
  const readReceipt = (path: string) =>
    JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

  test('a group with access to all builds is never POSTed; membership is read back as automatic', async () => {
    const output = receiptPath();
    const provider = stubProvider({
      group: groupPayload(true),
      readback: () => jsonResponse(members(['build-0', 'build-1'])),
    });
    try {
      await run(output, provider.hooks);
      expect(provider.calls).toEqual([
        'GET /v1/betaGroups',
        'GET /v1/betaGroups/group-1/relationships/builds',
      ]);
      expect(readReceipt(output)).toMatchObject({
        kind: 'testflight-internal-group-assignment',
        buildId: 'build-1',
        groupId: 'group-1',
        membership: 'automatic',
        hasAccessToAllBuilds: true,
        assignmentResponseStatus: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a group with access to all builds waits a bounded time for the build to appear, then fails closed without a POST', async () => {
    const output = receiptPath();
    const provider = stubProvider({
      group: groupPayload(true),
      readback: () => jsonResponse(members(['build-0'])),
    });
    try {
      await expect(run(output, provider.hooks)).rejects.toThrow(
        'App Store Connect beta group Station Nightly Internal (group-1) for app app-1 does not contain build build-1 before the deadline',
      );
      // 60 s deadline at 10 s per poll: the first read plus six more.
      const readbacks = provider.calls.filter((call) =>
        call.startsWith('GET /v1/betaGroups/group-1/relationships/builds'),
      );
      expect(readbacks).toHaveLength(7);
      expect(provider.calls.some((call) => call.startsWith('POST'))).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a group with access to all builds succeeds once a later poll lists the build', async () => {
    const output = receiptPath();
    let polls = 0;
    const provider = stubProvider({
      group: groupPayload(true),
      readback: () =>
        jsonResponse(members(++polls >= 3 ? ['build-1'] : ['build-0'])),
    });
    try {
      await run(output, provider.hooks);
      expect(polls).toBe(3);
      expect(provider.calls.some((call) => call.startsWith('POST'))).toBe(
        false,
      );
      expect(readReceipt(output).membership).toBe('automatic');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a group without access to all builds is POSTed, then read back as assigned', async () => {
    const output = receiptPath();
    const provider = stubProvider({
      group: groupPayload(false),
      post: () => new Response(null, { status: 204 }),
      readback: () => jsonResponse(members(['build-1'])),
    });
    try {
      await run(output, provider.hooks);
      expect(provider.calls).toEqual([
        'GET /v1/betaGroups',
        'POST /v1/betaGroups/group-1/relationships/builds',
        'GET /v1/betaGroups/group-1/relationships/builds',
      ]);
      expect(readReceipt(output)).toMatchObject({
        membership: 'assigned',
        hasAccessToAllBuilds: false,
        assignmentResponseStatus: 204,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a 409 on the POST is idempotent and still ends in an assigned readback', async () => {
    const output = receiptPath();
    const provider = stubProvider({
      group: groupPayload(false),
      post: () =>
        jsonResponse(
          { errors: [{ code: 'ENTITY_ERROR', detail: 'already related' }] },
          409,
        ),
      readback: () => jsonResponse(members(['build-1'])),
    });
    try {
      await run(output, provider.hooks);
      expect(provider.calls).toEqual([
        'GET /v1/betaGroups',
        'POST /v1/betaGroups/group-1/relationships/builds',
        'GET /v1/betaGroups/group-1/relationships/builds',
      ]);
      expect(readReceipt(output)).toMatchObject({
        membership: 'assigned',
        assignmentResponseStatus: 409,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('--deadline-seconds must be an integer from 10 to 600', async () => {
    const message = '--deadline-seconds must be an integer from 10 to 600';
    for (const rejected of ['9', '601', 'abc', '10.5']) {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        readback: () => jsonResponse(members(['build-1'])),
      });
      try {
        await expect(
          run(output, provider.hooks, ['--deadline-seconds', rejected]),
        ).rejects.toThrow(message);
        // Validation precedes every provider request and the receipt.
        expect(provider.calls).toEqual([]);
        expect(() => readFileSync(output)).toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    }
    for (const accepted of ['10', '600']) {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        readback: () => jsonResponse(members(['build-1'])),
      });
      try {
        await run(output, provider.hooks, ['--deadline-seconds', accepted]);
        expect(readReceipt(output).membership).toBe('automatic');
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  test('a readback listing the build more than once fails closed without polling again', async () => {
    const output = receiptPath();
    const provider = stubProvider({
      group: groupPayload(true),
      readback: () => jsonResponse(members(['build-1', 'build-0', 'build-1'])),
    });
    try {
      await expect(run(output, provider.hooks)).rejects.toThrow(
        'App Store Connect beta group group-1 lists build build-1 2 times',
      );
      expect(provider.calls).toEqual([
        'GET /v1/betaGroups',
        'GET /v1/betaGroups/group-1/relationships/builds',
      ]);
      expect(() => readFileSync(output)).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a group missing hasAccessToAllBuilds fails closed before any write', async () => {
    const output = receiptPath();
    const provider = stubProvider({
      group: groupPayload(undefined),
      readback: () => jsonResponse(members(['build-1'])),
      post: () => new Response(null, { status: 204 }),
    });
    try {
      await expect(run(output, provider.hooks)).rejects.toThrow(
        /hasAccessToAllBuilds as a boolean/,
      );
      expect(provider.calls).toEqual(['GET /v1/betaGroups']);
      expect(() => readFileSync(output)).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
