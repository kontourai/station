import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublicDocs, renderMarkdown } from '../build-github-pages.mjs';

const CANONICAL_REPOSITORY = 'https://github.com/kontourai/station';
const PREDECESSOR_REPOSITORY =
  'https://github.com/briananderson1222/work-agent';

function markdownFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(entryPath);
    return entry.isFile() && /\.mdx?$/.test(entry.name) ? [entryPath] : [];
  });
}

describe('public product documentation source links', () => {
  it('uses the canonical Station repository in the Pages source and generator', () => {
    for (const file of [
      'docs/pages/index.html',
      'scripts/build-github-pages.mjs',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain(CANONICAL_REPOSITORY);
      expect(source, file).not.toContain(PREDECESSOR_REPOSITORY);
    }
  });

  it('admits every allowlisted public doc through the build loader', async () => {
    // The real manifest through the real admission: schema, allowed roots,
    // git tracking, and regular-file checks all run against the checked-in
    // allowlist, so an internal doc added to it fails here.
    const sources = (await loadPublicDocs()).map(({ source }) => source);
    expect(sources.length).toBeGreaterThan(0);
    // Admissible by path, but contributor-internal.
    expect(sources).not.toContain('guides/testing.md');
    // The only binding between the published set and the allowlist: the
    // build reads its documents from loadPublicDocs, not a directory walk.
    const generator = readFileSync('scripts/build-github-pages.mjs', 'utf8');
    expect(generator).toContain('await loadPublicDocs()');
  });

  it('fails closed on escaping and duplicate public-doc sources', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'station-public-docs-'));
    const manifestPath = path.join(root, 'pages', 'public-docs.json');
    const options = { isTracked: () => true, manifestPath, root };
    try {
      await mkdir(path.join(root, 'pages'), { recursive: true });
      await mkdir(path.join(root, 'user'), { recursive: true });
      await writeFile(path.join(root, 'user', 'start.md'), '# Start\n');

      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          documents: [{ section: 'Start', source: '../outside.md' }],
        }),
      );
      await expect(loadPublicDocs(options)).rejects.toThrow(
        'Invalid public docs source',
      );

      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          documents: [
            { section: 'Start', source: 'user/start.md' },
            { section: 'Again', source: 'user/start.md' },
          ],
        }),
      );
      await expect(loadPublicDocs(options)).rejects.toThrow(
        'Duplicate public docs source',
      );

      await mkdir(path.join(root, 'reference'), { recursive: true });
      await writeFile(path.join(root, 'reference', 'other.md'), '# Other\n');
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          documents: [{ section: 'Reference', source: 'reference/other.md' }],
        }),
      );
      await expect(loadPublicDocs(options)).rejects.toThrow(
        'Invalid public docs source',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('keeps public product copy on canonical user-facing vocabulary', () => {
    const manifest = JSON.parse(
      readFileSync('docs/pages/public-docs.json', 'utf8'),
    ) as { documents: Array<{ source: string }> };
    const publicSources = [
      'README.md',
      'docs/pages/index.html',
      ...manifest.documents.map(({ source }) => `docs/${source}`),
    ];
    const retiredPhrases = [
      'managed agent',
      'connected runtime',
      'ACP runtime',
      'ACP agent',
      'ACP-compatible',
      'multiple runtimes',
      'Product Truth: Shipped, Gap, and Next',
    ];

    for (const file of publicSources) {
      const source = readFileSync(file, 'utf8');
      for (const phrase of retiredPhrases) {
        expect(source.toLowerCase(), `${file}: ${phrase}`).not.toContain(
          phrase.toLowerCase(),
        );
      }
    }
  });

  it('makes the admitted contributor guide self-sufficient across Just platforms', () => {
    const guide = readFileSync('docs/guides/contributing.md', 'utf8');
    for (const command of [
      'brew install just',
      'cargo install just --locked',
      'winget install --id Casey.Just --exact',
      'just --version',
      "just test 'name with spaces'",
      'just test "name with spaces"',
    ])
      expect(guide).toContain(command);
  });

  it('keeps example READMEs free of retired user-facing agent categories', () => {
    const exampleReadmes = readdirSync('examples', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join('examples', entry.name, 'README.md'))
      .filter(existsSync);
    const retiredPhrases = [
      'managed agent',
      'connected runtime',
      'ACP runtime',
      'ACP agent',
    ];

    expect(exampleReadmes.length).toBeGreaterThan(0);
    for (const file of exampleReadmes) {
      const source = readFileSync(file, 'utf8').toLowerCase();
      for (const phrase of retiredPhrases) {
        expect(source, `${file}: ${phrase}`).not.toContain(
          phrase.toLowerCase(),
        );
      }
    }
  });

  it('keeps current developer guidance on canonical agent categories', () => {
    const currentGuidance = [
      ...markdownFilesUnder('docs/guides'),
      ...markdownFilesUnder('docs/architecture'),
      ...markdownFilesUnder('docs/patterns'),
      'docs/architecture.md',
      'docs/reference/api-summary.md',
      'docs/reference/session-api.md',
    ];
    const retiredPhrases = [
      'managed agent',
      'connected runtime',
      'ACP runtime',
      'ACP agent',
      'runtime picker',
    ];

    expect(currentGuidance.length).toBeGreaterThan(0);
    for (const file of currentGuidance) {
      const source = readFileSync(file, 'utf8').toLowerCase();
      for (const phrase of retiredPhrases) {
        expect(source, `${file}: ${phrase}`).not.toContain(
          phrase.toLowerCase(),
        );
      }
    }
  });

  it('keeps generated Markdown tables horizontally reachable and focusable', () => {
    const html = renderMarkdown(
      ['| Name | Value |', '| --- | --- |', '| a | 1 |'].join('\n'),
    );
    const styles = readFileSync('docs/pages/styles.css', 'utf8');

    expect(html).toMatch(
      /<div class="table-scroll" tabindex="0" role="region" aria-label="[^"]+"><table>[\s\S]*<\/table><\/div>/,
    );
    expect(styles).toContain('.table-scroll {');
    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('.table-scroll:focus-visible');
  });

  it('routes contributors through the Module map', () => {
    const docsReadme = readFileSync('docs/README.md', 'utf8');
    const architecture = readFileSync('docs/architecture.md', 'utf8');

    expect(docsReadme).toContain('[architecture/module-map.md]');
    expect(architecture).toContain('[Module map](architecture/module-map.md)');
  });

  it('links contributors to the repository and public documentation boundaries', () => {
    const readme = readFileSync('README.md', 'utf8');
    const contributing = readFileSync('CONTRIBUTING.md', 'utf8');

    expect(readme).toContain('[Contributing](CONTRIBUTING.md)');
    expect(contributing).toContain('docs/pages/public-docs.json');
  });
});
