import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { discoverProjectIconCandidates } from '../project-icon-discovery.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

function workspace() {
  return mkdtempSync(join(tmpdir(), 'station-project-icons-'));
}

describe('project icon discovery', () => {
  test('ranks manifest artwork before common favicon and logo paths', async () => {
    const root = workspace();
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(
      join(root, 'public', 'site.webmanifest'),
      JSON.stringify({ icons: [{ src: './app.png' }] }),
    );
    writeFileSync(join(root, 'public', 'app.png'), PNG);
    writeFileSync(join(root, 'public', 'favicon.png'), PNG);
    writeFileSync(join(root, 'logo.png'), PNG);

    const candidates = await discoverProjectIconCandidates(root);

    expect(candidates.map((candidate) => candidate.relativePath)).toEqual([
      'public/app.png',
      'public/favicon.png',
      'logo.png',
    ]);
    expect(candidates[0]).toMatchObject({
      source: 'manifest',
      mediaType: 'image/png',
    });
    expect(candidates[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  test('ignores oversized files, fake images, and symlinks outside the workspace', async () => {
    const root = workspace();
    const outside = workspace();
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(
      join(root, 'public', 'favicon.png'),
      Buffer.from('not an image'),
    );
    writeFileSync(join(outside, 'logo.png'), PNG);
    symlinkSync(join(outside, 'logo.png'), join(root, 'logo.png'));

    await expect(discoverProjectIconCandidates(root)).resolves.toEqual([]);
  });

  test('fails without leaking filesystem details for inaccessible paths', async () => {
    await expect(
      discoverProjectIconCandidates(join(workspace(), 'missing')),
    ).rejects.toThrow();
  });
});
