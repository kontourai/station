import { writeFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:fs', () => ({ writeFileSync: vi.fn() }));
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test.each(['v0.1.11-nightly.1', 'v0.1.11', 'v0.1.11-preview.1'])(
  'the server notes CLI retries then applies the publication policy for %s',
  async (tag) => {
    vi.resetModules();
    vi.mocked(writeFileSync).mockClear();
    vi.stubEnv('GITHUB_REPOSITORY', 'kontourai/station');
    vi.stubEnv('GH_TOKEN', 'fixture-token');
    process.argv = [
      'node',
      'server-release-notes.mjs',
      tag,
      'a'.repeat(40),
      '/fixture/notes.md',
      'Install fixture',
    ];
    const request = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', request);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = import('../server-release-notes.mjs');
    if (tag.includes('nightly')) {
      await expect(run).resolves.toBeDefined();
      expect(writeFileSync).toHaveBeenCalledExactlyOnceWith(
        '/fixture/notes.md',
        '\n\n## Installation\n\nInstall fixture\n',
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('GitHub API was unavailable or rate limited.'),
      );
    } else {
      await expect(run).rejects.toThrow('HTTP 503');
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    }
    expect(request).toHaveBeenCalledTimes(2);
  },
);

test.each(['token', 'tag', 'permission'])(
  'Nightly never hides %s configuration errors',
  async (mode) => {
    vi.resetModules();
    vi.mocked(writeFileSync).mockClear();
    vi.stubEnv('GITHUB_REPOSITORY', 'kontourai/station');
    vi.stubEnv('GH_TOKEN', mode === 'token' ? '' : 'fixture-token');
    process.argv = [
      'node',
      'server-release-notes.mjs',
      mode === 'tag' ? 'invalid-nightly.1' : 'v0.1.11-nightly.1',
      'a'.repeat(40),
      '/fixture/notes.md',
      'Install fixture',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    await expect(import('../server-release-notes.mjs')).rejects.toThrow(
      mode === 'token'
        ? 'token are required'
        : mode === 'tag'
          ? 'exact-source'
          : 'HTTP 403',
    );
    expect(writeFileSync).not.toHaveBeenCalled();
  },
);

test.each(['missing', 'self', 'empty', 'compare-only'])(
  'Nightly falls back with a reason for %s content',
  async (mode) => {
    vi.resetModules();
    vi.mocked(writeFileSync).mockClear();
    vi.stubEnv('GITHUB_REPOSITORY', 'kontourai/station');
    vi.stubEnv('GH_TOKEN', 'fixture-token');
    process.argv = [
      'node',
      'server-release-notes.mjs',
      'v0.1.11-nightly.2',
      'a'.repeat(40),
      '/fixture/notes.md',
      'Install fixture',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/releases?'))
          return Response.json(
            mode === 'missing' ? [] : [{ tag_name: 'v0.1.11-nightly.1' }],
          );
        if (url.includes('/tags?')) return Response.json([]);
        if (url.includes('/commits/'))
          return Response.json({
            sha: (mode === 'self' ? 'a' : 'b').repeat(40),
          });
        if (url.endsWith('/generate-notes'))
          return Response.json({
            body:
              mode === 'empty'
                ? ''
                : '## What Changed\n**Full Changelog**: https://github.com/a/b/compare/a...b',
          });
        throw new Error(url);
      }),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await import('../server-release-notes.mjs');
    expect(writeFileSync).toHaveBeenCalledExactlyOnceWith(
      '/fixture/notes.md',
      '\n\n## Installation\n\nInstall fixture\n',
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        mode === 'missing'
          ? 'Previous server release is unavailable.'
          : 'No changes since the previous server release.',
      ),
    );
  },
);

test('the server CLI keeps installation beneath an oversized generated changelog', async () => {
  vi.resetModules();
  vi.mocked(writeFileSync).mockClear();
  vi.stubEnv('GITHUB_REPOSITORY', 'kontourai/station');
  vi.stubEnv('GH_TOKEN', 'fixture-token');
  process.argv = [
    'node',
    'server-release-notes.mjs',
    'v0.1.11',
    'a'.repeat(40),
    '/fixture/notes.md',
    'Install fixture',
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/releases?'))
        return Response.json([{ tag_name: 'v0.1.10' }]);
      if (url.includes('/commits/'))
        return Response.json({ sha: 'b'.repeat(40) });
      if (url.endsWith('/generate-notes'))
        return Response.json({
          body:
            '## What Changed\n' +
            ('* Change ' + 'x'.repeat(200) + '\n').repeat(2000),
        });
      throw new Error(url);
    }),
  );
  await import('../server-release-notes.mjs');
  const body = vi.mocked(writeFileSync).mock.calls[0][1] as string;
  expect(body.length).toBeLessThan(60000);
  expect(body).toContain('1900 changes omitted.');
  expect(body).toContain('## What Changed');
  expect(body).toContain('/compare/' + 'b'.repeat(40) + '...' + 'a'.repeat(40));
  expect(body).toContain('## Installation\n\nInstall fixture');
});

test('the nightly fallback warning logs a fixed reason without GitHub diagnostics', async () => {
  vi.resetModules();
  vi.mocked(writeFileSync).mockClear();
  vi.stubEnv('GITHUB_REPOSITORY', 'kontourai/station');
  vi.stubEnv('GH_TOKEN', 'fixture-token');
  process.argv = [
    'node',
    'server-release-notes.mjs',
    'v0.1.11-nightly.2',
    'a'.repeat(40),
    '/fixture/notes.md',
    'Install fixture',
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { message: 'upstream detail' },
        {
          status: 502,
          headers: {
            'x-oauth-scopes': 'repo, workflow',
            'x-ratelimit-remaining': '4999',
          },
        },
      ),
    ),
  );
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await import('../server-release-notes.mjs');
  const text = String(warning.mock.calls[0]?.[0]);
  expect(text).toContain('GitHub API was unavailable or rate limited.');
  expect(text).not.toContain('repo, workflow');
  expect(text).not.toContain('upstream detail');
  expect(writeFileSync).toHaveBeenCalledExactlyOnceWith(
    '/fixture/notes.md',
    '\n\n## Installation\n\nInstall fixture\n',
  );
});
