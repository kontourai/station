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
    await writeFile(path.join(root, 'docs', 'guide.md'), '# Start\n');
    await writeFile(
      path.join(root, 'README.md'),
      '# Local\n[Guide](docs/guide.md#start) [Local](#local) [Issue](https://github.com/kontourai/station/issues/272)',
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
        line: 1,
      },
      {
        file: 'docs/strategy/truth.md',
        label: 'Escape',
        reason: 'outside repository',
        target: '../../../outside.md',
        line: 1,
      },
    ]);
  });

  it('checks parsed reference links and ignores code and image literals', async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, 'README.md'),
      [
        '# Existing',
        '[**Missing**][target]',
        '',
        '[target]: #absent',
        '',
        '`[inline](missing.md#absent)`',
        '```md',
        '[fenced](missing.md#absent)',
        '```',
        '![image](missing.png)',
      ].join('\n'),
    );
    await expect(
      findBrokenMarkdownLinks({ files: ['README.md'], root }),
    ).resolves.toEqual([
      expect.objectContaining({
        label: 'Missing',
        target: '#absent',
        reason: 'missing anchor #absent',
        line: 2,
      }),
    ]);
  });

  it('uses rendered formatted headings, unique duplicate IDs, explicit IDs, and GFM footnotes', async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, 'README.md'),
      [
        '# **Café** `API` &amp; setup',
        '## Repeat',
        '## Repeat',
        '## Repeat-1',
        '<a id="stable"></a>',
        '<span id="repeat-2"></span>',
        '## Repeat',
        '[formatted](#caf%C3%A9-api--setup) [second](#repeat-1) [collision](#repeat-1-1) [reserved](#repeat-2) [fourth](#repeat-3) [explicit](#stable)',
        'Footnote[^one].',
        '[^one]: Footnote text.',
      ].join('\n\n'),
    );
    await expect(
      checkMarkdownLinks({ files: ['README.md'], root }),
    ).resolves.toBeUndefined();
  });

  it('rejects unsafe raw HTML and duplicate explicit IDs as anchor targets', async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, 'README.md'),
      [
        '<a id="unsafe" onclick="alert(1)"></a>',
        '<a id="twice"></a>',
        '<span id="twice"></span>',
        '[unsafe](#unsafe)',
      ].join('\n\n'),
    );
    await expect(
      findBrokenMarkdownLinks({ files: ['README.md'], root }),
    ).resolves.toEqual([
      expect.objectContaining({ target: '#twice', reason: 'duplicate anchor' }),
      expect.objectContaining({
        target: '#unsafe',
        reason: 'missing anchor #unsafe',
      }),
    ]);
  });

  it('checks main and exact current GitHub refs while leaving historical refs external', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'docs', 'guide.md'), '# Existing\n');
    await writeFile(
      path.join(root, 'README.md'),
      [
        '[main](https://github.com/kontourai/station/blob/main/docs/guide.md#missing)',
        '[current](https://github.com/kontourai/station/blob/current-sha/docs/guide.md#missing)',
        '[historical](https://github.com/kontourai/station/blob/old-sha/docs/guide.md#missing)',
        '[other repository](https://github.com/other/station/blob/main/docs/guide.md#missing)',
        '[valid](docs/guide.md?view=1#existing)',
      ].join('\n'),
    );
    await expect(
      findBrokenMarkdownLinks({
        files: ['README.md'],
        sourceFiles: ['README.md', 'docs/guide.md'],
        revision: 'current-sha',
        root,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        label: 'main',
        reason: 'missing anchor #missing',
      }),
      expect.objectContaining({
        label: 'current',
        reason: 'missing anchor #missing',
      }),
    ]);
  });

  it('decodes local paths and rejects malformed encodings and absolute or escaping paths', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'docs', 'space guide.md'), '# Café\n');
    await writeFile(
      path.join(root, 'README.md'),
      [
        '[valid](docs/space%20guide.md#caf%C3%A9)',
        '[malformed](#bad%ZZ)',
        '[absolute](/docs/space%20guide.md)',
        '[escape](%2e%2e/outside.md)',
      ].join('\n'),
    );
    await expect(
      findBrokenMarkdownLinks({ files: ['README.md'], root }),
    ).resolves.toEqual([
      expect.objectContaining({
        label: 'malformed',
        reason: 'invalid URL encoding',
      }),
      expect.objectContaining({
        label: 'absolute',
        reason: 'outside repository',
      }),
      expect.objectContaining({
        label: 'escape',
        reason: 'outside repository',
      }),
    ]);
  });
});
