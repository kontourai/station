import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkMarkdownLinks,
  findBrokenMarkdownLinks,
  parseTrackedMarkdownFiles,
} from '../check-markdown-links.mjs';

const temporaryRoots: string[] = [];

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'station-doc-links-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'docs', 'strategy'), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('Markdown relative-link gate', () => {
  it('parses tracked NUL-delimited discovery and drops empty entries', () => {
    expect(
      parseTrackedMarkdownFiles(
        'docs/z.mdx\0README.md\0examples/demo/README.md\0',
      ),
    ).toEqual(['README.md', 'docs/z.mdx', 'examples/demo/README.md']);
  });

  it('accepts existing files, fragments, and external destinations', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n');
    await writeFile(
      path.join(root, 'README.md'),
      '[Guide](docs/guide.md#start) [Local](#local) [Issue](https://github.com/kontourai/station/issues/272)',
    );

    await expect(
      checkMarkdownLinks({ files: ['README.md'], root }),
    ).resolves.toBeUndefined();
  });

  it('reports missing and repository-escaping targets with source context', async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, 'docs', 'strategy', 'truth.md'),
      '[Missing](../missing.md) [Escape](../../../outside.md)',
    );

    await expect(
      findBrokenMarkdownLinks({ files: ['docs/strategy/truth.md'], root }),
    ).resolves.toEqual([
      {
        file: 'docs/strategy/truth.md',
        label: 'Missing',
        reason: 'missing target',
        target: '../missing.md',
      },
      {
        file: 'docs/strategy/truth.md',
        label: 'Escape',
        reason: 'outside repository',
        target: '../../../outside.md',
      },
    ]);
  });
});
