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
        expect.stringContaining('::warning::'),
      );
    } else {
      await expect(run).rejects.toThrow('HTTP 503');
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    }
    expect(request).toHaveBeenCalledTimes(2);
  },
);
