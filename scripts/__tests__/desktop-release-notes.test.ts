import { afterEach, expect, test, vi } from 'vitest';
import {
  generateDesktopReleaseNotes,
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
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({ tag_name: tag, body: '- New features', draft: false }),
    );
  vi.stubGlobal('fetch', request);
  await publishDesktopReleaseNotes({
    ...options,
    manifest: { version, notes: '- New features' },
  });
  expect(request.mock.calls[0][0]).toBe(
    `https://api.github.com/repos/kontourai/station/releases/tags/${tag}`,
  );
  expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({
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
    expect(request).toHaveBeenCalledTimes(1);
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
    Response.json(url.includes('/commits/') ? { sha: source } : existing),
  );
  vi.stubGlobal('fetch', request);
  await publishDesktopReleaseNotes({
    ...options,
    manifest: { version, notes: '- Notes' },
  });
  expect(request).toHaveBeenCalledTimes(2);
  request.mockClear();
  await expect(
    publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Different notes' },
    }),
  ).rejects.toThrow('already differs');
  expect(request).toHaveBeenCalledTimes(2);
});

test('an existing tag at another source cannot acquire a misleading changelog', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ sha: previous }));
  vi.stubGlobal('fetch', request);
  await expect(
    publishDesktopReleaseNotes({
      ...options,
      manifest: { version, notes: '- Notes' },
    }),
  ).rejects.toThrow('different source');
  expect(request).toHaveBeenCalledTimes(2);
});
