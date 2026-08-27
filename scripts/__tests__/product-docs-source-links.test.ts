import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublicDocs } from '../build-github-pages.mjs';

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

  it('publishes an explicit end-user allowlist instead of the docs tree', () => {
    const manifest = JSON.parse(
      readFileSync('docs/pages/public-docs.json', 'utf8'),
    ) as {
      schemaVersion: number;
      documents: Array<{ section: string; source: string }>;
    };
    const generator = readFileSync('scripts/build-github-pages.mjs', 'utf8');

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.documents).toEqual([
      { section: 'Start Here', source: 'user/getting-started.md' },
      { section: 'Understand Station', source: 'user/concepts.md' },
      { section: 'Use Station', source: 'user/native-recovery.md' },
      { section: 'Use Station', source: 'user/work-board.md' },
      { section: 'Contribute', source: 'user/contributing.md' },
      { section: 'Contribute', source: 'guides/contributing.md' },
      { section: 'Use Station', source: 'guides/keyboard-shortcuts.md' },
      { section: 'Build Station', source: 'guides/product-law-authoring.md' },
      { section: 'Reference', source: 'reference/product-laws.md' },
      { section: 'Reference', source: 'reference/contributor-commands.md' },
    ]);
    expect(
      manifest.documents
        .map(({ source }) => source)
        .filter((source) => source.startsWith('reference/')),
    ).toEqual([
      'reference/product-laws.md',
      'reference/contributor-commands.md',
    ]);
    for (const document of manifest.documents) {
      expect(existsSync(`docs/${document.source}`), document.source).toBe(true);
      expect(document.source).not.toMatch(
        /^(?:adr|architecture|design|patterns|plans|strategy)\//,
      );
    }
    expect(manifest.documents.map(({ source }) => source)).not.toContain(
      'guides/testing.md',
    );
    expect(manifest.documents.map(({ source }) => source)).not.toContain(
      'AGENTS.md',
    );
    expect(generator).toContain("'public-docs.json'");
    expect(generator).toContain('loadPublicDocs()');
    expect(generator).not.toContain('collectMarkdown');
  });

  it('documents the individual-admission topology and source-versus-host boundary', () => {
    const pagesReadme = readFileSync('docs/pages/README.md', 'utf8');
    for (const phrase of [
      'exact, individual allowlist',
      'never\n  publishes a directory recursively',
      'generated\nreferences project exact command and product-law authorities',
      'hosted Pages deployment',
      'platform result',
      '**NOT_VERIFIED**',
    ])
      expect(pagesReadme).toContain(phrase);
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
    const generator = readFileSync('scripts/build-github-pages.mjs', 'utf8');
    const styles = readFileSync('docs/pages/styles.css', 'utf8');

    expect(generator).toContain(
      '<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table">',
    );
    expect(styles).toContain('.table-scroll {');
    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('.table-scroll:focus-visible');
  });

  it('routes contributors through the Module map and pins its documented scope', () => {
    const docsReadme = readFileSync('docs/README.md', 'utf8');
    const architecture = readFileSync('docs/architecture.md', 'utf8');
    const moduleMap = readFileSync('docs/architecture/module-map.md', 'utf8');

    expect(docsReadme).toContain('[architecture/module-map.md]');
    expect(architecture).toContain('[Module map](architecture/module-map.md)');
    for (const module of [
      'PendingPairingCompletion',
      'SessionQueryModule',
      'SessionCommandModule',
      'TurnDeduplicator',
      'AdoptionLedger',
      'RecoveryLedger',
      'CredentialRecoveryModule',
      'ConnectionInspector',
      'TaskDispatcher',
      'StationInstanceReconciler',
    ]) {
      expect(moduleMap).toContain(module);
    }
    expect(moduleMap).toContain(
      'Project-resource resolver evidence: #1501 and #1775',
    );
    expect(moduleMap).toContain('#2525 retained internal boundaries');
  });

  it('makes the repository and public documentation boundaries explicit', () => {
    const readme = readFileSync('README.md', 'utf8');
    const contributing = readFileSync('CONTRIBUTING.md', 'utf8');
    const docsReadme = readFileSync('docs/README.md', 'utf8');
    const pagesReadme = readFileSync('docs/pages/README.md', 'utf8');

    expect(readme).toContain('[Contributing](CONTRIBUTING.md)');
    expect(contributing).toContain('docs/pages/public-docs.json');
    expect(docsReadme).toContain('Repository only');
    expect(docsReadme).toContain(
      'GitHub issues and pull requests own live work state',
    );
    expect(pagesReadme).toContain('not a mirror of the');
  });
});
