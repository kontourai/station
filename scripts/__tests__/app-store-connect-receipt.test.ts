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
  resolveAppStoreConnectUrl,
  selectAppResource,
  selectBuildResources,
  selectInternalGroup,
  selectMembershipNextPage,
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
    readback: (url: URL) => Response;
    post?: () => Response;
  }) {
    const calls: string[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      urls.push(`${method} ${url.href}`);
      if (method === 'GET' && url.pathname === '/v1/betaGroups')
        return jsonResponse(handlers.group);
      if (
        method === 'GET' &&
        url.pathname === '/v1/betaGroups/group-1/relationships/builds'
      )
        return handlers.readback(url);
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
      urls,
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

  describe('paged readback (#1782)', () => {
    const relationship =
      'https://api.appstoreconnect.apple.com/v1/betaGroups/group-1/relationships/builds';
    const firstPage = `${relationship}?limit=200`;
    const pageUrl = (index: number) =>
      `${relationship}?cursor=p${index}&limit=200`;
    const readbacks = (provider: { urls: string[] }) =>
      provider.urls.filter((entry) => entry.startsWith(`GET ${relationship}`));

    /**
     * A provider whose relationship is split into pages addressed by a
     * `cursor` query parameter, each carrying the next page in `links.next`
     * exactly as a collection response does. `nextFor` overrides the link a
     * page returns so a hostile or malformed link is a one-line variant.
     */
    function pagedReadback(
      pages: string[][],
      nextFor: (index: number) => unknown = (index) =>
        index + 1 < pages.length ? pageUrl(index + 1) : undefined,
    ) {
      return (url: URL) => {
        const cursor = url.searchParams.get('cursor');
        const index = cursor === null ? 0 : Number(cursor.slice(1));
        const page = pages[index];
        if (!page) throw new Error(`unexpected page request ${url.href}`);
        const next = nextFor(index);
        return jsonResponse({
          data: page.map((id) => ({ type: 'builds', id })),
          links: {
            self: url.href,
            ...(next === undefined ? {} : { next }),
          },
        });
      };
    }
    const filler = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

    test('a build on the first page costs one request even when more pages exist', async () => {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        readback: pagedReadback([
          [...filler(199, 'old'), 'build-1'],
          filler(200, 'older'),
        ]),
      });
      try {
        await run(output, provider.hooks);
        expect(readbacks(provider)).toEqual([`GET ${firstPage}`]);
        expect(readReceipt(output)).toMatchObject({
          membership: 'automatic',
          membershipPagesRead: 1,
          membershipBuildsListed: 200,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test('a build on the third page is found by following links.next twice', async () => {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        readback: pagedReadback([
          filler(200, 'a'),
          filler(200, 'b'),
          ['c-0', 'build-1', 'c-2'],
        ]),
      });
      try {
        await run(output, provider.hooks);
        expect(readbacks(provider)).toEqual([
          `GET ${firstPage}`,
          `GET ${pageUrl(1)}`,
          `GET ${pageUrl(2)}`,
        ]);
        expect(readReceipt(output)).toMatchObject({
          membership: 'automatic',
          membershipPagesRead: 3,
          membershipBuildsListed: 403,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test('the assigned path reads back across pages as well', async () => {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(false),
        post: () => new Response(null, { status: 204 }),
        readback: pagedReadback([filler(200, 'a'), ['build-1']]),
      });
      try {
        await run(output, provider.hooks);
        expect(provider.calls).toEqual([
          'GET /v1/betaGroups',
          'POST /v1/betaGroups/group-1/relationships/builds',
          'GET /v1/betaGroups/group-1/relationships/builds',
          'GET /v1/betaGroups/group-1/relationships/builds',
        ]);
        expect(readReceipt(output)).toMatchObject({
          membership: 'assigned',
          assignmentResponseStatus: 204,
          membershipPagesRead: 2,
          membershipBuildsListed: 201,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test('a build absent from the first ten pages fails closed at the cap with its own text, without polling again', async () => {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        // Every page links onward: the group is larger than the reader walks.
        readback: pagedReadback(
          Array.from({ length: 12 }, (_, i) => filler(200, `p${i}`)),
          (index) => pageUrl(index + 1),
        ),
      });
      try {
        const failure = await run(output, provider.hooks).catch(
          (error: Error) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          'build build-1 was not found in the first 2000 builds (10 pages) of App Store Connect beta group Station Nightly Internal (group-1) for app app-1; the group lists more pages than this reader walks',
        );
        expect((failure as Error).message).not.toContain('does not contain');
        expect(readbacks(provider)).toHaveLength(10);
        expect(() => readFileSync(output)).toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test('a build absent from an exhausted list keeps polling to the deadline and reports what the last read covered', async () => {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        readback: pagedReadback([filler(200, 'a'), ['b-0', 'b-1']]),
      });
      try {
        await expect(run(output, provider.hooks)).rejects.toThrow(
          'App Store Connect beta group Station Nightly Internal (group-1) for app app-1 does not contain build build-1 before the deadline; the last read listed 202 builds across 2 pages',
        );
        // Seven polls of two pages each; no poll stops short of the last page.
        expect(readbacks(provider)).toHaveLength(14);
        expect(() => readFileSync(output)).toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test("a next-page link is followed only when it is this group's relationship on the provider origin", async () => {
      const refused: Array<[string, unknown]> = [
        [
          'off-origin host',
          'https://api.appstoreconnect.apple.com.evil.example/v1/betaGroups/group-1/relationships/builds?cursor=p1',
        ],
        [
          'plain http',
          'http://api.appstoreconnect.apple.com/v1/betaGroups/group-1/relationships/builds?cursor=p1',
        ],
        [
          'another group',
          'https://api.appstoreconnect.apple.com/v1/betaGroups/group-2/relationships/builds?cursor=p1',
        ],
        [
          'another resource',
          'https://api.appstoreconnect.apple.com/v1/builds?cursor=p1',
        ],
        [
          'embedded credentials',
          'https://user:secret@api.appstoreconnect.apple.com/v1/betaGroups/group-1/relationships/builds?cursor=p1',
        ],
        [
          'relative path',
          '/v1/betaGroups/group-1/relationships/builds?cursor=p1',
        ],
        ['the page itself', firstPage],
        ['not a string', { href: pageUrl(1) }],
      ];
      for (const [label, next] of refused) {
        const output = receiptPath();
        const provider = stubProvider({
          group: groupPayload(true),
          readback: pagedReadback([filler(3, 'a'), ['build-1']], () => next),
        });
        try {
          await expect(run(output, provider.hooks), label).rejects.toThrow(
            'App Store Connect beta group group-1 returned a next-page link that is not https://api.appstoreconnect.apple.com/v1/betaGroups/group-1/relationships/builds; refusing to follow it',
          );
          // The link was never fetched and the wait did not continue.
          expect(provider.urls, label).toEqual([
            'GET https://api.appstoreconnect.apple.com/v1/betaGroups?filter%5Bapp%5D=app-1&filter%5Bname%5D=Station+Nightly+Internal&limit=2',
            `GET ${firstPage}`,
          ]);
          expect(() => readFileSync(output), label).toThrow();
        } finally {
          vi.unstubAllGlobals();
        }
      }
      expect(
        selectMembershipNextPage(
          { links: { self: firstPage, next: pageUrl(1) } },
          { groupId: 'group-1', currentUrl: firstPage },
        ),
      ).toBe(pageUrl(1));
      expect(
        selectMembershipNextPage(
          { links: { self: firstPage } },
          { groupId: 'group-1', currentUrl: firstPage },
        ),
      ).toBeNull();
    });

    test('a build listed twice on a later page fails closed without polling again', async () => {
      const output = receiptPath();
      const provider = stubProvider({
        group: groupPayload(true),
        readback: pagedReadback([
          filler(200, 'a'),
          ['build-1', 'b-0', 'build-1'],
        ]),
      });
      try {
        await expect(run(output, provider.hooks)).rejects.toThrow(
          'App Store Connect beta group group-1 lists build build-1 2 times',
        );
        expect(readbacks(provider)).toEqual([
          `GET ${firstPage}`,
          `GET ${pageUrl(1)}`,
        ]);
        expect(() => readFileSync(output)).toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe('resolveAppStoreConnectUrl', () => {
  test('accepts a path or an absolute provider URL and refuses any other origin', async () => {
    expect(resolveAppStoreConnectUrl('/v1/apps?limit=2').href).toBe(
      'https://api.appstoreconnect.apple.com/v1/apps?limit=2',
    );
    expect(
      resolveAppStoreConnectUrl(
        'https://api.appstoreconnect.apple.com/v1/builds?cursor=x',
      ).href,
    ).toBe('https://api.appstoreconnect.apple.com/v1/builds?cursor=x');
    for (const rejected of [
      'https://evil.example/v1/apps',
      'http://api.appstoreconnect.apple.com/v1/apps',
      'https://user:pw@api.appstoreconnect.apple.com/v1/apps',
      '//evil.example/v1/apps',
    ]) {
      expect(() => resolveAppStoreConnectUrl(rejected)).toThrow(
        'App Store Connect request must stay on https://api.appstoreconnect.apple.com',
      );
    }
    // The request path enforces it before any credential leaves the process.
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(
      appStoreConnectRequest(
        'https://evil.example/v1/apps',
        { issuerId: 'issuer', keyId: 'key', privateKey },
        fetchImpl,
      ),
    ).rejects.toThrow('must stay on');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
