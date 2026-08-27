import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkGeneratedPageLinks,
  findBrokenGeneratedPageLinks,
  findGeneratedHtmlFiles,
} from '../check-generated-pages-links.mjs';

const temporaryRoots: string[] = [];

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'station-pages-links-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'dist-pages', 'docs'), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('generated Pages relative-link gate', () => {
  it('accepts generated files, directories, fragments, and external links', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'dist-pages', 'styles.css'), '');
    await writeFile(path.join(root, 'dist-pages', 'docs', 'index.html'), '');
    await writeFile(
      path.join(root, 'dist-pages', 'index.html'),
      '<a href="./docs/">Docs</a><link href="./styles.css"><a href="#truth">Truth</a><a href="https://github.com/kontourai/station">Source</a>',
    );

    await expect(
      checkGeneratedPageLinks({ files: ['dist-pages/index.html'], root }),
    ).resolves.toBeUndefined();
  });

  it('reports missing and escaping generated destinations', async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, 'dist-pages', 'docs', 'truth.html'),
      '<a href="./missing.html">Missing</a><a href="../../outside.html">Escape</a>',
    );

    await expect(
      findBrokenGeneratedPageLinks({
        files: ['dist-pages/docs/truth.html'],
        root,
      }),
    ).resolves.toEqual([
      {
        file: 'dist-pages/docs/truth.html',
        href: './missing.html',
        reason: 'missing generated target',
      },
      {
        file: 'dist-pages/docs/truth.html',
        href: '../../outside.html',
        reason: 'outside generated site',
      },
    ]);
  });

  it('discovers every generated HTML file recursively', async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, 'dist-pages', 'docs', 'user'), {
      recursive: true,
    });
    await writeFile(path.join(root, 'dist-pages', 'index.html'), '');
    await writeFile(path.join(root, 'dist-pages', 'docs', 'index.html'), '');
    await writeFile(
      path.join(root, 'dist-pages', 'docs', 'user', 'start.html'),
      '',
    );
    await writeFile(path.join(root, 'dist-pages', 'robots.txt'), '');

    await expect(findGeneratedHtmlFiles({ root })).resolves.toEqual([
      'dist-pages/docs/index.html',
      'dist-pages/docs/user/start.html',
      'dist-pages/index.html',
    ]);
  });

  it('checks the complete generated site when files are omitted', async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, 'dist-pages', 'docs', 'user'), {
      recursive: true,
    });
    await writeFile(path.join(root, 'dist-pages', 'index.html'), '');
    await writeFile(
      path.join(root, 'dist-pages', 'docs', 'user', 'start.html'),
      '<a href="./missing.html">Missing</a>',
    );

    await expect(findBrokenGeneratedPageLinks({ root })).resolves.toEqual([
      {
        file: 'dist-pages/docs/user/start.html',
        href: './missing.html',
        reason: 'missing generated target',
      },
    ]);
  });
});
