import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  STATION_DOCS_CONTENT_DIGEST,
  STATION_DOCS_TOPICS,
} from '../../src-server/tools/station-docs-content.js';
import {
  buildLearningGuide,
  learningHref,
  renderLearningDocument,
} from '../build-learning-guide.mjs';
import { checkMarkdownLinks } from '../check-markdown-links.mjs';
import { INDEXED_DIRECTORIES } from '../docs-index.mjs';
import {
  compileStationDocs,
  readStationDocsInputs,
  stationDocsDigest,
} from '../generate-station-docs.mjs';
import {
  documentSections,
  extractModules,
  validateCatalog,
} from '../lib/documentation-model.mjs';
import { compileDocumentationReviews } from '../lib/documentation-review.mjs';
import { publishImmutableSnapshot } from '../lib/immutable-snapshot.mjs';

const makeTempDir = trackTempDirs();

describe('immutable source publication', () => {
  it('accepts identical existing bytes and refuses truncated or different evidence without replacing it', async () => {
    const directory = makeTempDir('station-immutable-source-');
    const destination = join(directory, 'source.txt');
    const bytes = Buffer.from('complete captured source');
    await publishImmutableSnapshot(destination, bytes);
    await publishImmutableSnapshot(destination, bytes);
    expect(await fs.readFile(destination)).toEqual(bytes);
    for (const invalid of [
      bytes.subarray(0, 8),
      Buffer.alloc(bytes.length, 120),
    ]) {
      await fs.writeFile(destination, invalid);
      await expect(
        publishImmutableSnapshot(destination, bytes),
      ).rejects.toThrow(`Immutable source snapshot mismatch: ${destination}`);
      expect(await fs.readFile(destination)).toEqual(invalid);
      expect(await fs.readdir(directory)).toEqual(['source.txt']);
    }
  });

  it('publishes no destination when interrupted before the atomic link, then permits a complete retry', async () => {
    const directory = makeTempDir('station-immutable-source-');
    const destination = join(directory, 'source.txt');
    const bytes = Buffer.from('complete captured source');
    const interrupted = new Error('injected publication interruption');
    const link = vi
      .spyOn(fs, 'link')
      .mockImplementationOnce(async (temporary, target) => {
        expect(target).toBe(destination);
        expect(await fs.readFile(temporary)).toEqual(bytes);
        await expect(fs.stat(destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        throw interrupted;
      });
    try {
      await expect(publishImmutableSnapshot(destination, bytes)).rejects.toBe(
        interrupted,
      );
      expect(link).toHaveBeenCalledOnce();
    } finally {
      link.mockRestore();
    }
    expect(await fs.readdir(directory)).toEqual([]);
    await publishImmutableSnapshot(destination, bytes);
    expect(await fs.readFile(destination)).toEqual(bytes);
  });

  it('joins concurrent identical publication and rejects a conflicting publisher without overwriting the winner', async () => {
    const directory = makeTempDir('station-immutable-source-');
    const destination = join(directory, 'source.txt');
    const bytes = Buffer.from('same captured bytes');
    await Promise.all(
      Array.from({ length: 4 }, () =>
        publishImmutableSnapshot(destination, bytes),
      ),
    );
    expect(await fs.readFile(destination)).toEqual(bytes);
    expect(await fs.readdir(directory)).toEqual(['source.txt']);
    const contested = join(directory, 'contested.txt');
    const alternatives = [
      Buffer.from('first complete source'),
      Buffer.from('second complete source'),
    ];
    const results = await Promise.allSettled(
      alternatives.map((value) => publishImmutableSnapshot(contested, value)),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(await fs.readFile(contested)).toEqual(alternatives[winner]);
    expect(results[1 - winner]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: `Immutable source snapshot mismatch: ${contested}`,
      }),
    });
    expect((await fs.readdir(directory)).sort()).toEqual([
      'contested.txt',
      'source.txt',
    ]);
  });
});

// docs/README.md indexed roughly half the docs tree when this was written —
// 17 ADRs and eight whole directories were unreachable from the map that calls
// itself the map. Directory-level reachability is enforced here (the README
// stays curated prose); file-level completeness for the two drift-prone
// directories is enforced by the generated docs-index blocks.

function tracked(args: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\n')
    .filter(Boolean);
}

describe('docs index reachability', () => {
  const index = readFileSync('docs/README.md', 'utf8');

  it('mentions every top-level docs/ directory', () => {
    const directories = new Set(
      tracked(['docs'])
        .map((path) => path.split('/'))
        .filter((parts) => parts.length > 2)
        .map((parts) => parts[1]),
    );
    expect(directories.size).toBeGreaterThan(10);
    for (const directory of directories) {
      expect(index, `docs/README.md never mentions docs/${directory}/`).toMatch(
        new RegExp(`\\(${directory}/`),
      );
    }
  });

  it('links every root-level docs/*.md', () => {
    const roots = tracked(['docs/*.md'])
      .filter((path) => path.split('/').length === 2)
      .map((path) => path.slice('docs/'.length))
      .filter((name) => name !== 'README.md');
    expect(roots.length).toBeGreaterThan(3);
    for (const name of roots) {
      expect(index, `docs/README.md never links docs/${name}`).toContain(
        `(${name})`,
      );
    }
  });

  it('the generated per-directory indexes match their tracked files', () => {
    // Regenerate-and-diff, as a real child process so the npm entry point and
    // its non-zero drift exit are proven, not just the pure functions.
    const result = execFileSync('node', ['scripts/docs-index.mjs', '--check'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result).toBe('');
  });

  it('both indexed READMEs still carry their marker blocks', () => {
    for (const directory of INDEXED_DIRECTORIES) {
      const body = readFileSync(`${directory}/README.md`, 'utf8');
      expect(
        body,
        `${directory}/README.md lost its docs-index block`,
      ).toContain('docs-index:start');
    }
  });
});

describe('learning atlas', () => {
  it('refuses leaf and ancestor symlinks before publishing captured Markdown, source, or reader assets', async () => {
    const directory = makeTempDir('station-reader-confinement-');
    const root = join(directory, 'repo');
    await fs.mkdir(join(root, 'docs/architecture'), { recursive: true });
    await fs.mkdir(join(root, 'docs/learn'), { recursive: true });
    await fs.mkdir(join(root, 'evidence'), { recursive: true });
    await fs.mkdir(join(directory, 'outside'), { recursive: true });
    const original = Buffer.from('# Sentinel\n\nIN_REPOSITORY_BYTES\n');
    const outside = Buffer.from('# Sentinel\n\nCONTROLLED_OUTSIDE_BYTES\n');
    const source = Buffer.from(
      'export const fixture = "IN_REPOSITORY_BYTES";\n',
    );
    await fs.writeFile(join(root, '.gitignore'), '.kontourai/\n');
    await fs.writeFile(
      join(root, 'README.md'),
      '# Fixture\n\n[Markdown](evidence/linked.md#sentinel) [Source](evidence/source.ts)\n',
    );
    await fs.writeFile(join(root, 'evidence/linked.md'), original);
    await fs.writeFile(join(root, 'evidence/source.ts'), source);
    await fs.writeFile(join(directory, 'outside/linked.md'), outside);
    await fs.writeFile(join(directory, 'outside/source.ts'), outside);
    await fs.writeFile(join(directory, 'outside/index.html'), outside);
    await fs.writeFile(
      join(root, 'docs/architecture/module-map.md'),
      '## Fixture module\n',
    );
    await fs.writeFile(
      join(root, 'docs/learn/atlas.json'),
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: 'fixture',
            title: 'Fixture',
            summary: 'Source boundary',
            docs: ['README.md'],
            modules: ['Fixture module'],
            questions: ['Which bytes?'],
          },
        ],
      }),
    );
    await fs.writeFile(
      join(root, 'docs/learn/review-ledger.json'),
      JSON.stringify({ version: 1, records: [] }),
    );
    for (const asset of ['index.html', 'atlas.css', 'atlas.js'])
      await fs.writeFile(
        join(root, 'docs/learn', asset),
        '/* in-repository reader fixture */',
      );
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
    git(['init', '--quiet']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Committed confinement baseline',
    ]);
    expect(git(['status', '--porcelain'])).toBe('');
    const sourceFiles = git(['ls-files', '-z']).split('\0').filter(Boolean);
    const files = sourceFiles.filter((file) => file.endsWith('.md'));
    const check = () => checkMarkdownLinks({ files, sourceFiles, root });
    await check();
    const baseline = await buildLearningGuide({ root });
    const sourcePath = join(
      root,
      '.kontourai/docs-learning',
      baseline.sourceSnapshots['evidence/linked.md'],
    );
    expect(await fs.readFile(sourcePath)).toEqual(original);

    for (const [file, target] of [
      ['evidence/linked.md', join(directory, 'outside/linked.md')],
      ['evidence/source.ts', join(directory, 'outside/source.ts')],
      ['docs/learn/index.html', join(directory, 'outside/index.html')],
    ]) {
      const location = join(root, file);
      const before = await fs.readFile(location);
      await fs.unlink(location);
      await fs.symlink(target, location);
      try {
        // Reader assets are not Markdown links; the real generator still must
        // refuse their bytes when copying the completed site's static files.
        if (!file.startsWith('docs/learn/'))
          await expect(check()).rejects.toThrow(
            'Learning source symlink is not allowed',
          );
        await expect(buildLearningGuide({ root })).rejects.toThrow(
          'Learning source symlink is not allowed',
        );
        expect(await fs.readFile(sourcePath)).toEqual(original);
      } finally {
        expect(await fs.readlink(location)).toBe(target);
        await fs.unlink(location);
        await fs.writeFile(location, before);
      }
      expect(await fs.readFile(location)).toEqual(before);
      expect(git(['status', '--porcelain'])).toBe('');
    }

    await fs.rename(join(root, 'evidence'), join(root, 'retained-evidence'));
    await fs.symlink(join(directory, 'outside'), join(root, 'evidence'), 'dir');
    try {
      await expect(check()).rejects.toThrow(
        'Learning source symlink is not allowed',
      );
      await expect(buildLearningGuide({ root })).rejects.toThrow(
        'Learning source symlink is not allowed',
      );
      expect(await fs.readFile(sourcePath)).toEqual(original);
    } finally {
      expect(await fs.readlink(join(root, 'evidence'))).toBe(
        join(directory, 'outside'),
      );
      await fs.unlink(join(root, 'evidence'));
      await fs.rename(join(root, 'retained-evidence'), join(root, 'evidence'));
    }
    expect(git(['status', '--porcelain'])).toBe('');
    await check();
    const restored = await buildLearningGuide({ root });
    expect(restored.sourceSnapshots).toEqual(baseline.sourceSnapshots);
    expect(await fs.readFile(sourcePath)).toEqual(original);
    expect(await fs.readFile(join(directory, 'outside/linked.md'))).toEqual(
      outside,
    );
    const outsideDigest = createHash('sha256').update(outside).digest('hex');
    await expect(
      fs.stat(join(root, '.kontourai/docs-learning/sources', outsideDigest)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails the real generator on a removed local heading and passes after restoring its committed bytes', async () => {
    const root = makeTempDir('station-anchor-generator-');
    await fs.mkdir(join(root, 'docs/learn'), { recursive: true });
    await fs.mkdir(join(root, 'docs/architecture'), { recursive: true });
    const target = '# **Target** `API`\n\n<a id="stable"></a>\n';
    await fs.writeFile(join(root, 'target.md'), target);
    await fs.writeFile(
      join(root, 'README.md'),
      [
        '# Reader fixture',
        '[relative](target.md#target-api)',
        '[self](#reader-fixture)',
        '[directory](docs/architecture/) [root](./)',
        '[explicit](target.md#stable)',
        '[main](https://github.com/kontourai/station/blob/main/target.md#target-api)',
        '[historical](https://github.com/kontourai/station/blob/old-sha/target.md#absent)',
        '`[inline fixture](missing.md#absent)`',
        '```md\n[fenced fixture](missing.md#absent)\n```',
      ].join('\n\n'),
    );
    await fs.writeFile(
      join(root, 'docs/architecture/module-map.md'),
      '## Fixture module\n',
    );
    await fs.writeFile(
      join(root, 'docs/learn/review-ledger.json'),
      JSON.stringify({ version: 1, records: [] }),
    );
    await fs.writeFile(
      join(root, 'docs/learn/atlas.json'),
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: 'fixture',
            title: 'Fixture',
            summary: 'Anchor fixture',
            docs: ['README.md', 'target.md#stable'],
            modules: ['Fixture module'],
            questions: ['Where is the section?'],
          },
        ],
      }),
    );
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        windowsHide: true,
        encoding: 'utf8',
      });
    git(['init', '--quiet']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Anchor fixture baseline',
    ]);
    expect(git(['status', '--porcelain'])).toBe('');
    const generator = new URL('../build-learning-guide.mjs', import.meta.url)
      .href;
    const check = () =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { buildLearningGuide } from ${JSON.stringify(generator)}; try { await buildLearningGuide({check:true,root:${JSON.stringify(root)}}); } catch (error) { console.error(error.message); process.exitCode=1; }`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
    const baseline = check();
    expect(baseline.stderr).toBe('');
    expect(baseline.status).toBe(0);
    try {
      await fs.writeFile(
        join(root, 'target.md'),
        target.replace('Target', 'Renamed'),
      );
      const mutated = check();
      expect(mutated.status).toBe(1);
      expect(mutated.stderr).toContain(
        'README.md:3: [relative](target.md#target-api) — missing anchor #target-api',
      );
      expect(mutated.stderr).toContain(
        '[main](https://github.com/kontourai/station/blob/main/target.md#target-api) — missing anchor #target-api',
      );
      expect(mutated.stderr).not.toContain('historical');
    } finally {
      await fs.writeFile(join(root, 'target.md'), target);
    }
    expect(git(['status', '--porcelain'])).toBe('');
    const restored = check();
    expect(restored.stderr).toBe('');
    expect(restored.status).toBe(0);
  });

  it('keeps recorded document reviews bound to their actual document and source bytes', async () => {
    const files = new Set(tracked([]));
    const ledger = JSON.parse(
      readFileSync('docs/learn/review-ledger.json', 'utf8'),
    );
    const documents = new Map(
      [...files]
        .filter((file) => /\.(md|mdx|markdown)$/i.test(file))
        .map((file) => [
          file,
          createHash('sha256').update(readFileSync(file)).digest('hex'),
        ]),
    );
    const reviews = await compileDocumentationReviews(
      ledger,
      documents,
      files,
      async (file: string) => readFileSync(file),
      { requireFresh: true },
    );
    expect(reviews.size).toBe(ledger.records.length);
    expect(reviews.size).toBeGreaterThan(0);
  });

  it('invalidates review status when either the document or its code changes', async () => {
    const digest = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    const record = {
      path: 'guide.md',
      kind: 'current',
      state: 'source-reviewed',
      documentDigest: digest('Guide'),
      sourceRevision: 'a'.repeat(40),
      summary: 'Checked the caller and failure path.',
      limits: 'No live provider was exercised.',
      sources: [{ path: 'owner.ts', digest: digest('code') }],
      checks: ['Focused caller test passed.'],
    };
    const docs = new Map([['guide.md', digest('Guide')]]);
    const files = new Set(['guide.md', 'owner.ts']);
    const ledger = { version: 1, records: [record] };
    const read = async () => 'code';
    expect(
      (await compileDocumentationReviews(ledger, docs, files, read)).get(
        'guide.md',
      )?.state,
    ).toBe('source-reviewed');
    const changedCode = await compileDocumentationReviews(
      ledger,
      docs,
      files,
      async () => 'changed code',
    );
    expect(changedCode.get('guide.md')).toMatchObject({
      state: 'needs-review',
      changed: ['owner.ts'],
    });
    await expect(
      compileDocumentationReviews(
        ledger,
        docs,
        files,
        async () => 'changed code',
        { requireFresh: true },
      ),
    ).rejects.toThrow('Documentation review needs refresh');
    const changedDoc = new Map([['guide.md', digest('Changed guide')]]);
    expect(
      (await compileDocumentationReviews(ledger, changedDoc, files, read)).get(
        'guide.md',
      )?.state,
    ).toBe('needs-review');
    await expect(
      compileDocumentationReviews(ledger, docs, new Set(['guide.md']), read),
    ).rejects.toThrow('Invalid review source');
    await expect(
      compileDocumentationReviews(
        { version: 1, records: [record, record] },
        docs,
        files,
        read,
      ),
    ).rejects.toThrow('duplicate reviewed document');
    expect(
      (
        await compileDocumentationReviews(
          { version: 1, records: [] },
          docs,
          files,
          read,
        )
      ).size,
    ).toBe(0);
  });

  it('keeps example headings inside code fences out of the navigation tree', () => {
    const source =
      '## Boundary\n\n```markdown\n## Example only\n```\n\n~~~md\n## Another example\n~~~\n\n## Recovery\n\nRefuse stale work.';
    expect(
      documentSections(source).map(
        (section: { title: string }) => section.title,
      ),
    ).toEqual(['Boundary', 'Recovery']);
    expect(documentSections(source)[0].body).toContain('## Example only');
  });
  it('ships the exact canonical prose and tree through the credential-free MCP', async () => {
    const compiled = await readStationDocsInputs();
    expect(STATION_DOCS_TOPICS).toEqual(compiled);
    expect(STATION_DOCS_CONTENT_DIGEST).toBe(stationDocsDigest(compiled));
    const changed = structuredClone(compiled);
    changed[0].body += '\nChanged behavior.';
    expect(stationDocsDigest(changed)).not.toBe(STATION_DOCS_CONTENT_DIGEST);
  });

  it('rejects missing or uncatalogued shipped prose instead of silently omitting it', () => {
    const catalog = {
      version: 1,
      source: 'docs/reference/station-docs.md',
      topics: [
        {
          id: 'start',
          title: 'Start',
          section: 'Start',
          summary: 'Starting',
          tags: ['start'],
        },
      ],
    };
    const atlas = {
      version: 1,
      groups: [
        {
          id: 'execution',
          title: 'Execution',
          summary: 'Run work',
          docs: ['docs/architecture/module-map.md'],
          modules: ['StartBoundary'],
          questions: ['Who owns start?'],
        },
      ],
    };
    const modules = '## StartBoundary\n\nAccepts or refuses a start.';
    expect(() =>
      compileStationDocs('# Manual', catalog, modules, atlas),
    ).toThrow('Missing shipped-documentation section');
    expect(() =>
      compileStationDocs(
        '## Start\n\nRun work.\n\n## Uncatalogued\n\nLost prose.',
        catalog,
        modules,
        atlas,
      ),
    ).toThrow('Uncatalogued shipped sections');
    const topics = compileStationDocs(
      '## Start\n\nRun work.',
      catalog,
      modules,
      atlas,
    );
    expect(topics[0].body).toBe('Run work.');
    expect(
      topics.find(
        (topic: { id: string }) => topic.id === 'architecture-startboundary',
      )?.body,
    ).toContain('Accepts or refuses a start.');
  });
  it('assigns every actual module exactly once and keeps its reading documents tracked', () => {
    const catalog = JSON.parse(readFileSync('docs/learn/atlas.json', 'utf8'));
    const modules = extractModules(
      readFileSync('docs/architecture/module-map.md', 'utf8'),
    );
    const files = new Set(tracked(['*.md', '*.mdx', '*.markdown']));
    expect(() => validateCatalog(catalog, modules, files)).not.toThrow();
    expect(() =>
      validateCatalog(
        catalog,
        [...modules, { title: 'New unassigned boundary' }],
        files,
      ),
    ).toThrow('missing from learning tree');
    expect(() => validateCatalog(catalog, modules, new Set())).toThrow(
      'Untracked learning document',
    );
    const duplicate = structuredClone(catalog);
    duplicate.groups[1].modules.push(duplicate.groups[0].modules[0]);
    expect(() => validateCatalog(duplicate, modules, files)).toThrow(
      'Multiply assigned module',
    );
    const unknown = structuredClone(catalog);
    unknown.groups[0].modules.push('Removed boundary');
    expect(() => validateCatalog(unknown, modules, files)).toThrow(
      'Unknown module',
    );
  });

  it('keeps Markdown links in the reader while source links use the recorded revision', () => {
    const files = new Set(['docs/guide.md', 'README.md', 'docs/café notes.md']);
    expect(
      learningHref(
        'https://github.com/kontourai/station/blob/main/docs/guide.md#read',
        'README.md',
        files,
        'abc',
      ),
    ).toBe('#doc=docs%2Fguide.md&section=read');
    const oldRevision =
      'https://github.com/kontourai/station/blob/older/docs/guide.md#read';
    expect(learningHref(oldRevision, 'README.md', files, 'abc')).toBe(
      oldRevision,
    );
    expect(
      learningHref('../README.md#setup', 'docs/guide.md', files, 'abc'),
    ).toBe('#doc=README.md&section=setup');
    expect(learningHref('#same-page', 'docs/guide.md', files, 'abc')).toBe(
      '#doc=docs%2Fguide.md&section=same-page',
    );
    expect(
      learningHref('caf%C3%A9%20notes.md', 'docs/guide.md', files, 'abc'),
    ).toBe('#doc=docs%2Fcaf%C3%A9%20notes.md');
    expect(
      learningHref('../src-server/index.ts', 'docs/guide.md', files, 'abc'),
    ).toBe('https://github.com/kontourai/station/blob/abc/src-server/index.ts');
    expect(
      learningHref(
        '../src-server/index.ts',
        'docs/guide.md',
        files,
        'abc',
        new Set(['src-server/index.ts']),
      ),
    ).toBe('sources/src-server/index.ts.txt');
    for (const ref of ['main', 'abc'])
      expect(
        learningHref(
          `https://github.com/kontourai/station/blob/${ref}/src-server/index.ts`,
          'README.md',
          files,
          'abc',
          new Set(['src-server/index.ts']),
        ),
      ).toBe('sources/src-server/index.ts.txt');
    const oldSource =
      'https://github.com/kontourai/station/blob/older/src-server/index.ts';
    expect(
      learningHref(
        oldSource,
        'README.md',
        files,
        'abc',
        new Set(['src-server/index.ts']),
      ),
    ).toBe(oldSource);
    expect(learningHref('../../outside', 'docs/guide.md', files, 'abc')).toBe(
      '',
    );
    expect(
      learningHref('javascript:alert(1)', 'docs/guide.md', files, 'abc'),
    ).toBe('');
    expect(
      learningHref('https://example.com/guide', 'docs/guide.md', files, 'abc'),
    ).toBe('https://example.com/guide');
  });

  it('routes tracked native and extensionless text locally through links and inline source references', () => {
    const sources = new Set([
      'Dockerfile',
      'station',
      'justfile',
      '.githooks/pre-push',
      '.githooks/commit-msg',
      '.gitignore',
      '.npmrc',
      '.nvmrc',
      '.env.example',
      'LICENSE',
      'scripts/__tests__/fixtures/sbom/SPDX-LICENSE',
      'patches/native/LICENSE-APACHE',
      'patches/native/LICENSE-MIT',
      'scripts/templates/android/StationAndroidInsetsBridge.kt',
      'src-desktop/Cargo.lock',
      'src-desktop/Info.ios.plist',
      'src-desktop/gen/android/app/build.gradle.kts',
      'native/Bridge.swift',
      'native/Bridge.h',
      'native/Bridge.mm',
      'native/bridge.go',
      'native/go.mod',
      'native/go.sum',
      'native/Main.java',
      'native/project.pbxproj',
      'native/App.entitlements',
      'native/PrivacyInfo.xcprivacy',
      'native/gradlew',
      'native/Podfile',
      'native/gradle.properties',
      'native/proguard-rules.pro',
      'native/config.xml',
      'native/Runner.cs',
      'scripts/check.ps1',
    ]);
    const files = new Set(['docs/guide.md']);
    for (const file of sources) {
      const local = `sources/${file}.txt`;
      expect(
        learningHref(`../${file}`, 'docs/guide.md', files, 'current', sources),
        file,
      ).toBe(local);
      for (const revision of ['main', 'current'])
        expect(
          learningHref(
            `https://github.com/kontourai/station/blob/${revision}/${file}`,
            'docs/guide.md',
            files,
            'current',
            sources,
          ),
          file,
        ).toBe(local);
      const historical = `https://github.com/kontourai/station/blob/older/${file}`;
      expect(
        learningHref(historical, 'docs/guide.md', files, 'current', sources),
      ).toBe(historical);
      expect(
        renderLearningDocument(
          `\`${file}\``,
          'docs/guide.md',
          files,
          'current',
          sources,
        ).html,
      ).toContain(`href="${local}"`);
    }
  });

  it('keeps binary assets and untracked text outside local source snapshots', () => {
    const sources = new Set([
      'icons/icon.png',
      'icons/icon.icns',
      'icons/icon.ico',
      'photo.jpg',
      'font.woff2',
      'archive.jar',
      'manual.pdf',
      '.DS_Store',
      '.githooks/icon.png',
    ]);
    const files = new Set(['README.md']);
    for (const file of [...sources, 'untracked.swift']) {
      const remote = `https://github.com/kontourai/station/blob/current/${file}`;
      expect(learningHref(file, 'README.md', files, 'current', sources)).toBe(
        remote,
      );
      expect(
        renderLearningDocument(
          `\`${file}\``,
          'README.md',
          files,
          'current',
          sources,
        ).html,
      ).not.toContain('href="sources/');
    }
  });

  it('renders useful Markdown, duplicate heading anchors, and inert raw HTML', () => {
    const rendered = renderLearningDocument(
      '# Guide\n\n## Recovery\n\n## Recovery\n\n| State | Meaning |\n| --- | --- |\n| Pending | Not complete |\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert)\n\n```mermaid\ngraph LR\nA-->B\n```',
      'docs/guide.md',
      new Set(['docs/guide.md']),
      'abc',
    );
    expect(
      rendered.headings.map((heading: { id: string }) => heading.id),
    ).toEqual(['guide', 'recovery', 'recovery-1']);
    expect(rendered.html).toContain('<table>');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).not.toContain('href="javascript:');
    expect(rendered.html).toContain('Diagram source');
    expect(rendered.html).toContain('A--&gt;B');
  });

  it('renders only safe empty explicit anchors and retains inert code literals', () => {
    const rendered = renderLearningDocument(
      [
        '<a id="stable"></a>',
        '<span id="another"></span>',
        '<a name="legacy"></a>',
        'An inline <a id="inline"></a> anchor.',
        '<a id="unsafe" onclick="alert(1)"></a>',
        '`<a id="literal"></a>`',
        '```html\n<span id="fenced"></span>\n```',
      ].join('\n\n'),
      'README.md',
      new Set(['README.md']),
      'current',
    );
    expect(rendered.anchors).toEqual(['stable', 'another', 'legacy', 'inline']);
    for (const id of rendered.anchors)
      expect(rendered.html).toContain(`<span id="${id}"></span>`);
    expect(rendered.html).not.toContain('<a id="unsafe"');
    expect(rendered.html).toContain('&lt;a id=&quot;unsafe&quot;');
    expect(rendered.html).toContain('&lt;a id=&quot;literal&quot;');
    expect(rendered.html).toContain('&lt;span id=&quot;fenced&quot;');
  });

  it('reserves the generated footnote heading ID before user headings', () => {
    const rendered = renderLearningDocument(
      '# Footnote label\n\nReference[^one].\n\n[^one]: Body.',
      'README.md',
      new Set(['README.md']),
      'current',
    );
    expect(rendered.headings).toEqual([
      { id: 'footnote-label-1', level: 1, title: 'Footnote label' },
      { id: 'footnote-label', level: 2, title: 'Footnotes' },
    ]);
    expect(rendered.html).toContain('aria-describedby="footnote-label"');
    expect(rendered.html).toContain('<h2 id="footnote-label">Footnotes</h2>');
    expect(rendered.duplicateAnchors).toEqual([]);
  });
});
