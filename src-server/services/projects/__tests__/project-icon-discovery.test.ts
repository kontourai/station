import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  discoverProjectIconCandidates,
  withDiscoveredProjectIcon,
} from '../project-icon-discovery.js';

const { reads, probes } = vi.hoisted(() => ({
  reads: [] as string[],
  probes: [] as string[],
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    realpath: (...args: Parameters<typeof fs.realpath>) => {
      probes.push(String(args[0]));
      return fs.realpath(...args);
    },
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      reads.push(String(args[0]));
      return fs.readFile(...args);
    },
  };
});

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

  test('discovers bounded monorepo public artwork and derives a default only for a repository', async () => {
    const root = workspace();
    mkdirSync(join(root, 'apps', 'web', 'public'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'public', 'favicon.png'), PNG);
    expect((await discoverProjectIconCandidates(root))[0].relativePath).toBe(
      'apps/web/public/favicon.png',
    );
    const project: {
      workingDirectory: string;
      icon?: string;
      iconDisabled?: boolean;
      derivedIcon?: string;
    } = {
      workingDirectory: root,
    };
    expect(await withDiscoveredProjectIcon(project)).toBe(project);
    mkdirSync(join(root, '.git'));
    const displayed = await withDiscoveredProjectIcon(project);
    expect(displayed.derivedIcon).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`,
    );
    expect(displayed).not.toHaveProperty('icon');
    expect(project).not.toHaveProperty('icon');
    expect(
      await withDiscoveredProjectIcon({ ...project, iconDisabled: true }),
    ).not.toHaveProperty('derivedIcon');
    writeFileSync(
      join(root, 'apps', 'web', 'public', 'favicon.png'),
      Buffer.concat([PNG, Buffer.from('changed')]),
    );
    expect((await withDiscoveredProjectIcon(project)).derivedIcon).not.toBe(
      displayed.derivedIcon,
    );
    expect(await withDiscoveredProjectIcon({ ...project, icon: '🐈' })).toEqual(
      { ...project, icon: '🐈' },
    );
  });

  test('automatic display stops at the first small valid candidate and reuses unchanged bytes', async () => {
    const root = workspace();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'favicon.png'), PNG);
    writeFileSync(join(root, 'logo.png'), PNG);
    const project: { workingDirectory: string; derivedIcon?: string } = {
      workingDirectory: root,
    };
    reads.length = 0;
    const first = await withDiscoveredProjectIcon(project);
    expect(first.derivedIcon).toBeTruthy();
    expect(reads.filter((path) => path.endsWith('.png'))).toEqual([
      realpathSync(join(root, 'favicon.png')),
    ]);
    reads.length = 0;
    expect((await withDiscoveredProjectIcon(project)).derivedIcon).toBe(
      first.derivedIcon,
    );
    expect(reads.filter((path) => path.endsWith('.png'))).toEqual([]);
  });

  test('automatic display caps artwork bytes while the explicit picker keeps the stored-image bound', async () => {
    const root = workspace();
    mkdirSync(join(root, '.git'));
    const large = Buffer.alloc(13 * 1024);
    PNG.copy(large);
    writeFileSync(join(root, 'favicon.png'), large);
    const project: { workingDirectory: string; derivedIcon?: string } = {
      workingDirectory: root,
    };
    expect(await withDiscoveredProjectIcon(project)).not.toHaveProperty(
      'derivedIcon',
    );
    expect(await discoverProjectIconCandidates(root)).toHaveLength(1);
  });

  test('caches absent artwork probes and discovers newly added nested artwork', async () => {
    const root = workspace();
    mkdirSync(join(root, 'apps', 'web', 'public'), { recursive: true });
    await expect(discoverProjectIconCandidates(root)).resolves.toEqual([]);
    probes.length = 0;
    await expect(discoverProjectIconCandidates(root)).resolves.toEqual([]);
    expect(probes).toEqual([root]);
    writeFileSync(join(root, 'apps', 'web', 'public', 'favicon.png'), PNG);
    expect((await discoverProjectIconCandidates(root))[0].relativePath).toBe(
      'apps/web/public/favicon.png',
    );
  });

  test('fails without leaking filesystem details for inaccessible paths', async () => {
    await expect(
      discoverProjectIconCandidates(join(workspace(), 'missing')),
    ).rejects.toThrow();
  });
});
