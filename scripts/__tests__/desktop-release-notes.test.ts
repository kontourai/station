import { afterEach, expect, test, vi } from 'vitest';
import {
  generateDesktopReleaseNotes,
  generateServerReleaseNotes,
  publishDesktopReleaseNotes,
} from '../lib/desktop-release-notes.mjs';

const source = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const version = '0.1.11-nightly.2499.3';
const tag = `desktop-v${version}`;
const plan = { sourceSha: source, versionIdentities: { desktop: { version } } };
const options = { plan, repository: 'kontourai/station', token: 'test-token' };

afterEach(() => vi.unstubAllGlobals());

test('GitHub generates the staged version’s notes and the full changelog retains immutable source bounds', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sha: previous }))
    .mockResolvedValueOnce(
      Response.json({
        body: `## Features\n- New tools (#123)\n\n**Full Changelog**: https://github.com/kontourai/station/compare/nightly-desktop...${tag}`,
      }),
    )
    .mockResolvedValueOnce(Response.json({ sha: previous }));
  vi.stubGlobal('fetch', request);
  const notes = await generateDesktopReleaseNotes(options);
  expect(notes).toContain('- New tools (#123)');
  expect(notes).toContain(`/compare/${previous}...${source}`);
  const [, generated] = request.mock.calls[1];
  expect(JSON.parse(generated.body)).toEqual({
    tag_name: tag,
    target_commitish: source,
    previous_tag_name: 'nightly-desktop',
  });
});

test('a moving previous desktop marker refuses ambiguous generated notes', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sha: previous }))
    .mockResolvedValueOnce(Response.json({ body: '- Some changes' }))
    .mockResolvedValueOnce(Response.json({ sha: 'c'.repeat(40) }));
  vi.stubGlobal('fetch', request);
  await expect(generateDesktopReleaseNotes(options)).rejects.toThrow('moved');
});

test('publication archives the exact updater notes as a versioned prerelease without changing latest', async () => {
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (
      url.endsWith(`/releases/tags/${tag}`) ||
      url.endsWith(`/git/ref/tags/${tag}`)
    )
      return new Response('', { status: 404 });
    if (url.endsWith(`/commits/${tag}`))
      return Response.json(
        { message: `No commit found for SHA: ${tag}` },
        { status: 422 },
      );
    if (url.endsWith('/releases') && init.method === 'POST')
      return Response.json({
        tag_name: tag,
        body: '- New features',
        draft: false,
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', request);
  await publishDesktopReleaseNotes({
    ...options,
    manifest: { version, notes: '- New features' },
  });
  expect(request.mock.calls[0][0]).toBe(
    `https://api.github.com/repos/kontourai/station/releases/tags/${tag}`,
  );
  const body = request.mock.calls[2][1].body;
  if (typeof body !== 'string')
    throw new Error('Expected a serialized JSON release body');
  expect(JSON.parse(body)).toEqual({
    tag_name: tag,
    target_commitish: source,
    name: `Station desktop ${version}`,
    body: '- New features',
    draft: false,
    prerelease: true,
    make_latest: 'false',
  });
});

test.each([401, 403, 503])(
  'a failed archive lookup (HTTP %s) never becomes a release creation',
  async (status) => {
    const request = vi.fn(async () => new Response('', { status }));
    vi.stubGlobal('fetch', request);
    await expect(
      publishDesktopReleaseNotes({
        ...options,
        manifest: { version, notes: '- Notes' },
      }),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(request).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
  },
);

test('a rejected release reports bounded validation and permission diagnostics without request secrets or retries', async () => {
  const notes = '- Private staged notes';
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          message: 'Validation Failed',
          errors: [
            {
              resource: 'Release',
              field: 'tag_name',
              code: 'custom',
              message: `tag_name is not a valid tag ${options.token} ${notes}`,
              value: 'provider value must not be logged',
            },
          ],
          debug: 'provider debug must not be logged',
        },
        {
          status: 422,
          headers: {
            'x-github-request-id': 'ABCD:1234',
            'x-accepted-github-permissions': 'contents=write;workflows=write',
            'x-oauth-scopes': 'repo, workflow',
            'set-cookie': 'provider cookie must not be logged',
          },
        },
      ),
    );
  vi.stubGlobal('fetch', request);
  const result = publishDesktopReleaseNotes({
    ...options,
    manifest: { version, notes },
  });
  await expect(result).rejects.toThrow('HTTP 422 POST /releases');
  await expect(result).rejects.toThrow('Validation Failed');
  await expect(result).rejects.toThrow('tag_name is not a valid tag');
  await expect(result).rejects.toThrow('contents=write;workflows=write');
  await expect(result).rejects.toThrow('repo, workflow');
  await expect(result).rejects.toThrow('ABCD:1234');
  for (const secret of [
    options.token,
    notes,
    'provider value',
    'provider debug',
    'provider cookie',
  ]) {
    await expect(result).rejects.not.toThrow(secret);
  }
  expect(request).toHaveBeenCalledTimes(3);
});

test.each([
  'not JSON: secret response',
  JSON.stringify({
    message: 'x'.repeat(20_000),
    errors: Array(100).fill({ code: 'x'.repeat(20_000) }),
  }),
])(
  'unstructured or excessive provider errors cannot flood the diagnostic',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 503 })),
    );
    const result = publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Notes' },
    });
    const error = await result.catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('HTTP 503 GET /releases/tags/');
    expect(String(error)).not.toContain('secret response');
    expect(String(error).length).toBeLessThan(4096);
  },
);

test('an existing archive is reused only for identical source and notes', async () => {
  const existing = {
    tag_name: tag,
    target_commitish: source,
    body: '- Notes',
    draft: false,
    prerelease: true,
  };
  const request = vi.fn(async (url: string) =>
    Response.json(
      url.includes('/commits/')
        ? { sha: source }
        : url.includes('/git/ref/')
          ? { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: source } }
          : existing,
    ),
  );
  vi.stubGlobal('fetch', request);
  await publishDesktopReleaseNotes({
    ...options,
    manifest: { version, notes: '- Notes' },
  });
  expect(request).toHaveBeenCalledTimes(3);
  request.mockClear();
  await expect(
    publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Different notes' },
    }),
  ).rejects.toThrow('already differs');
  expect(request).toHaveBeenCalledTimes(3);
});

test('an existing tag at another source cannot acquire a misleading changelog', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({
        ref: `refs/tags/${tag}`,
        object: { type: 'commit', sha: previous },
      }),
    )
    .mockResolvedValueOnce(Response.json({ sha: previous }));
  vi.stubGlobal('fetch', request);
  await expect(
    publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Notes' },
    }),
  ).rejects.toThrow('different source');
  expect(request).toHaveBeenCalledTimes(3);
});

test('an archived release without its tag cannot be adopted as exact-source proof', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        tag_name: tag,
        target_commitish: source,
        body: '- Notes',
        draft: false,
        prerelease: true,
      }),
    )
    .mockResolvedValueOnce(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', request);
  await expect(
    publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Notes' },
    }),
  ).rejects.toThrow('tag is unavailable');
  expect(request).toHaveBeenCalledTimes(2);
});

test('a tag lookup validation error never authorizes a release creation', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({ message: 'Validation Failed' }, { status: 422 }),
    );
  vi.stubGlobal('fetch', request);
  await expect(
    publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Notes' },
    }),
  ).rejects.toThrow('HTTP 422 GET /git/ref/tags/');
  expect(request).toHaveBeenCalledTimes(2);
});

test.each(['v0.1.12', 'v0.1.12-nightly.2500', 'v0.1.12-preview.2'])(
  'server notes for %s exclude desktop, rolling, other rings and newer releases',
  async (serverTag) => {
    const priorTag = serverTag.replace('0.1.12', '0.1.11');
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          { tag_name: 'v99.0.0', draft: false },
          { tag_name: 'nightly-server', draft: false },
          { tag_name: `desktop-${priorTag}`, draft: false },
          {
            tag_name: serverTag.includes('nightly')
              ? 'v0.1.11-preview.1'
              : 'v0.1.11-nightly.2499',
            draft: false,
          },
          { tag_name: priorTag, draft: true },
          { tag_name: priorTag, draft: false },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ sha: previous }))
      .mockResolvedValueOnce(
        Response.json({
          body: `- Server changes\n/compare/${priorTag}...${serverTag}`,
        }),
      )
      .mockResolvedValueOnce(Response.json({ sha: previous }));
    vi.stubGlobal('fetch', request);
    const notes = await generateServerReleaseNotes({
      tag: serverTag,
      source,
      repository: options.repository,
      token: options.token,
    });
    expect(notes).toContain('- Server changes');
    expect(notes).toContain(`/compare/${previous}...${source}`);
    expect(JSON.parse(request.mock.calls[2][1].body)).toMatchObject({
      tag_name: serverTag,
      previous_tag_name: priorTag,
      target_commitish: source,
    });
  },
);

test('server notes fail closed without a previous release', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([])),
  );
  await expect(
    generateServerReleaseNotes({
      tag: 'v0.1.12',
      source,
      repository: options.repository,
      token: options.token,
    }),
  ).rejects.toThrow('Previous server release');
});

test('the first stable release spans the highest preceding base version regardless of API order', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        { tag_name: 'v0.1.12-preview.1', draft: false },
        { tag_name: 'v0.1.9-nightly.99' },
        { tag_name: 'v0.1.11-nightly.2' },
        { tag_name: 'v0.1.10-nightly.99' },
      ]),
    )
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ sha: previous }))
    .mockResolvedValueOnce(Response.json({ body: '- Stable server changes' }))
    .mockResolvedValueOnce(Response.json({ sha: previous }));
  vi.stubGlobal('fetch', request);
  await generateServerReleaseNotes({
    tag: 'v0.1.12',
    source,
    repository: options.repository,
    token: options.token,
  });
  expect(JSON.parse(request.mock.calls[3][1].body).previous_tag_name).toBe(
    'v0.1.11-nightly.2',
  );
});

test.each(['self', 'empty'])(
  'stable server notes describe %s comparisons',
  async (mode) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([{ tag_name: 'v0.1.10' }]))
        .mockResolvedValueOnce(
          Response.json({ sha: mode === 'self' ? source : previous }),
        )
        .mockResolvedValueOnce(
          Response.json({
            body: '## What Changed\n**Full Changelog**: https://github.com/a/b/compare/v0.1.10...v0.1.11',
          }),
        )
        .mockResolvedValueOnce(Response.json({ sha: previous })),
    );
    await expect(
      generateServerReleaseNotes({
        tag: 'v0.1.11',
        source,
        repository: options.repository,
        token: options.token,
      }),
    ).resolves.toBe('No changes since v0.1.10.');
  },
);
test.each([503, 429, 403, 'timeout'])(
  'note generation retries transient %s once',
  async (status) => {
    const request = vi.fn();
    if (status === 'timeout')
      request.mockRejectedValueOnce(
        new DOMException('timeout', 'TimeoutError'),
      );
    else
      request.mockResolvedValueOnce(
        new Response('', {
          status: Number(status),
          headers: { 'retry-after': '1' },
        }),
      );
    request
      .mockResolvedValueOnce(Response.json({ sha: previous }))
      .mockResolvedValueOnce(Response.json({ body: '- Changes' }))
      .mockResolvedValueOnce(Response.json({ sha: previous }));
    vi.stubGlobal('fetch', request);
    await expect(generateDesktopReleaseNotes(options)).resolves.toBe(
      '- Changes',
    );
    expect(request).toHaveBeenCalledTimes(4);
  },
);

test.each([
  ['v0.1.11-nightly.999', 'v0.1.11'],
  ['v0.1.11-preview.1', 'v0.1.11-nightly.999'],
])('new-channel fallback orders %s and %s by semver', async (first, second) => {
  const tags = [first, second];
  const expected = tags.includes('v0.1.11') ? 'v0.1.11' : 'v0.1.11-preview.1';
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/releases?'))
      return Response.json(tags.map((tag_name) => ({ tag_name })));
    if (url.includes('/tags?')) return Response.json([]);
    if (url.includes('/commits/')) return Response.json({ sha: previous });
    if (url.endsWith('/generate-notes')) {
      expect(JSON.parse(String(init?.body)).previous_tag_name).toBe(expected);
      return Response.json({ body: '- Changes' });
    }
    throw new Error(url);
  });
  vi.stubGlobal('fetch', request);
  await expect(
    generateServerReleaseNotes({
      tag: 'v0.1.12-preview.1',
      source,
      repository: options.repository,
      token: options.token,
    }),
  ).resolves.toBe('- Changes');
});

test('real-history stable promotion uses an older plain git tag when Releases contain only same-base nightlies', async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/releases?'))
      return Response.json([{ tag_name: 'v0.1.11-nightly.2026111300' }]);
    if (url.includes('/tags?'))
      return Response.json([
        { name: 'v0.1.11-nightly.2026111300' },
        { name: 'v0.1.10' },
      ]);
    if (url.includes('/commits/v0.1.10'))
      return Response.json({ sha: previous });
    if (url.endsWith('/releases/generate-notes')) {
      expect(JSON.parse(String(init?.body)).previous_tag_name).toBe('v0.1.10');
      return Response.json({ body: '- Stable changes' });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', request);
  await expect(
    generateServerReleaseNotes({
      tag: 'v0.1.11',
      source,
      repository: options.repository,
      token: options.token,
    }),
  ).resolves.toBe('- Stable changes');
  expect(request).toHaveBeenCalledTimes(5);
});

test.each([
  ['2', 2000],
  ['120', 30000],
  ['invalid', 250],
])(
  'retry-after %s delays the second request by %s ms',
  async (header, delay) => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', {
            status: 429,
            headers: { 'retry-after': String(header) },
          }),
        )
        .mockResolvedValueOnce(Response.json({ sha: previous }))
        .mockResolvedValueOnce(Response.json({ body: '- Changes' }))
        .mockResolvedValueOnce(Response.json({ sha: previous }));
      vi.stubGlobal('fetch', request);
      const result = generateDesktopReleaseNotes(options);
      await vi.advanceTimersByTimeAsync(Number(delay) - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('- Changes');
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each([
  [2000, 150, 100],
  [30, 6000, 8],
])(
  'large generated release bodies (%s entries, %s characters) retain header and immutable compare under the publication budget',
  async (count, width, shown) => {
    const body =
      '## What Changed\n' +
      Array.from(
        { length: count },
        (_, i) => `* Change ${i} ${'x'.repeat(width)}`,
      ).join('\n');
    expect(body.length).toBeGreaterThan(125000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/releases?'))
          return Response.json([{ tag_name: 'v0.1.10' }]);
        if (url.includes('/commits/')) return Response.json({ sha: previous });
        if (url.endsWith('/generate-notes')) return Response.json({ body });
        throw new Error(url);
      }),
    );
    const notes = await generateServerReleaseNotes({
      tag: 'v0.1.11',
      source,
      repository: options.repository,
      token: options.token,
    });
    expect(notes.length).toBeLessThan(50000);
    expect(notes).toContain('## What Changed');
    expect(notes).toContain(`${count - shown} changes omitted.`);
    expect(notes).toContain(`/compare/${previous}...${source}`);
    expect((notes.match(/^\* Change/gm) ?? []).length).toBe(shown);
  },
);

test('fallback picks the newest older version across Releases and git tags', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/releases?'))
        return Response.json([{ tag_name: 'v0.1.8-nightly.1' }]);
      if (url.includes('/tags?')) return Response.json([{ name: 'v0.1.10' }]);
      if (url.includes('/commits/v0.1.10'))
        return Response.json({ sha: previous });
      if (url.endsWith('/generate-notes')) {
        expect(JSON.parse(String(init?.body)).previous_tag_name).toBe(
          'v0.1.10',
        );
        return Response.json({ body: '- Changes' });
      }
      throw new Error(url);
    }),
  );
  await expect(
    generateServerReleaseNotes({
      tag: 'v0.1.11',
      source,
      repository: options.repository,
      token: options.token,
    }),
  ).resolves.toBe('- Changes');
});

test.each([
  [5, 5000],
  [120, 30000],
])(
  'rate-limit reset in %s seconds waits %s ms without retry-after',
  async (seconds, delay) => {
    vi.useFakeTimers();
    try {
      const reset = Math.floor(Date.now() / 1000) + seconds;
      vi.setSystemTime((reset - seconds) * 1000);
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(reset),
            },
          }),
        )
        .mockResolvedValueOnce(Response.json({ sha: previous }))
        .mockResolvedValueOnce(Response.json({ body: '- Changes' }))
        .mockResolvedValueOnce(Response.json({ sha: previous }));
      vi.stubGlobal('fetch', request);
      const result = generateDesktopReleaseNotes(options);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('- Changes');
    } finally {
      vi.useRealTimers();
    }
  },
);

test('a server error with quota remaining ignores the rate-limit reset', async () => {
  vi.useFakeTimers();
  try {
    // GitHub sends x-ratelimit-reset on ordinary responses too; waiting for it
    // here would stall a transient 502 for up to the 30s cap.
    const reset = Math.floor(Date.now() / 1000) + 120;
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', {
          status: 502,
          headers: {
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': String(reset),
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ sha: previous }))
      .mockResolvedValueOnce(Response.json({ body: '- Changes' }))
      .mockResolvedValueOnce(Response.json({ sha: previous }));
    vi.stubGlobal('fetch', request);
    const result = generateDesktopReleaseNotes(options);
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('- Changes');
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['v0.1.11-rc.1', 'v0.1.10'],
  ['v0.1.11-rc.3', 'v0.1.11-rc.2'],
  ['v0.1.11', 'v0.1.10'],
])(
  'server notes for %s compare against %s across RC promotion',
  async (tag, prior) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/releases?'))
          return Response.json([
            { tag_name: 'v0.1.11-rc.2' },
            { tag_name: 'v0.1.11-rc.4', draft: true },
            { tag_name: 'v0.1.10' },
          ]);
        if (url.includes(`/commits/${prior}`))
          return Response.json({ sha: previous });
        if (url.endsWith('/generate-notes')) {
          expect(JSON.parse(String(init?.body)).previous_tag_name).toBe(prior);
          return Response.json({ body: '* RC promotion changes' });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    await expect(
      generateServerReleaseNotes({
        tag,
        source,
        repository: options.repository,
        token: options.token,
      }),
    ).resolves.toBe('* RC promotion changes');
  },
);

test.each(['v0.1.11-rc.0', 'v0.1.11-rc.99', 'v0.1.11-rc.1.2'])(
  'server notes refuse invalid release identity %s before contacting GitHub',
  async (tag) => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(
      generateServerReleaseNotes({
        tag,
        source,
        repository: options.repository,
        token: options.token,
      }),
    ).rejects.toThrow('exact-source');
    expect(request).not.toHaveBeenCalled();
  },
);
