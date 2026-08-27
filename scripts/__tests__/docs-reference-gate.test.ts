import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MISSING,
  describeLiveDocScope,
  findBrokenReferences,
  LIVE_DOC_DIRECTORIES,
  LIVE_DOC_FILES,
  liveDocs,
  normalizeReferencedPath,
  referencedPaths,
  runDocsReferenceGate,
} from '../docs-reference-gate.mjs';

describe('referencedPaths', () => {
  it('finds backticked repo paths', () => {
    expect(
      referencedPaths('See `src-server/index.ts` and `packages/sdk/src/x.ts`.'),
    ).toEqual(['src-server/index.ts', 'packages/sdk/src/x.ts']);
  });

  it('ignores backticked things that are not repo paths', () => {
    expect(
      referencedPaths('Run `npm run build` or set `STATION_HOME`.'),
    ).toEqual([]);
  });

  it('strips trailing punctuation that belongs to the sentence', () => {
    expect(referencedPaths('in `src-server/a.ts`,')).toEqual([
      'src-server/a.ts',
    ]);
  });

  it('deduplicates repeated references', () => {
    expect(referencedPaths('`src-ui/x.ts` and again `src-ui/x.ts`')).toEqual([
      'src-ui/x.ts',
    ]);
  });

  it('normalizes documented source locations in code and link contexts', () => {
    expect(
      referencedPaths(
        '`src-server/runtime/file.ts:42` and [source](<packages/café space/file.ts:9-12>)',
      ),
    ).toEqual(['src-server/runtime/file.ts', 'packages/café space/file.ts']);
    expect(normalizeReferencedPath('src-ui/src/view.tsx:7')).toBe(
      'src-ui/src/view.tsx',
    );
    expect(normalizeReferencedPath('src-ui/src/view.tsx:7-11')).toBe(
      'src-ui/src/view.tsx',
    );
    expect(normalizeReferencedPath('src-ui/src/view.tsx:7,11-13')).toBe(
      'src-ui/src/view.tsx',
    );
    expect(
      referencedPaths('`https://example.test:443/x` `#123` `C:\\x:7`'),
    ).toEqual([]);
    expect(referencedPaths('`src-server/providers/*`')).toEqual([]);
    expect(referencedPaths('[source](<https://example.test/path>)')).toEqual(
      [],
    );
  });

  it('rejects malformed colon-bearing source references instead of ignoring them', () => {
    expect(() => referencedPaths('`src-server/runtime/file.ts:line`')).toThrow(
      "Unsupported source-path location reference 'src-server/runtime/file.ts:line'.",
    );
    expect(() => referencedPaths('`src-server/file:12.ts`')).toThrow(
      "Unsupported source-path location reference 'src-server/file:12.ts'.",
    );
    for (const reference of [
      'src-server/runtime/file.ts:1:2',
      'src-server/runtime/file.ts:1-3:4',
      'src-server/runtime/file.ts:1,2:3',
    ]) {
      expect(() => referencedPaths(`\`${reference}\``)).toThrow(
        `Unsupported source-path location reference '${reference}'.`,
      );
    }
    expect(() =>
      referencedPaths('[source](packages/café space/file.ts:9-12)'),
    ).toThrow('require CommonMark angle brackets');
    expect(() => referencedPaths('[source](<>)')).toThrow(
      'is empty or contains a control character',
    );
    expect(() => referencedPaths('[source](<packages/file.ts\n>)')).toThrow(
      'is empty or contains a control character',
    );
    for (const reference of [
      'packages/sdk/src/\n> queries.ts',
      'packages/sdk/src/\r\n>     queries.ts',
    ]) {
      expect(() => referencedPaths(`\`${reference}\``)).toThrow(
        'Concrete source-path code span contains a line break',
      );
    }
    expect(referencedPaths('`src-server/feature/{one,\n> two}.ts`')).toEqual(
      [],
    );
  });
});

describe('findBrokenReferences', () => {
  it('reports a nonexistent location base path', () => {
    const broken = findBrokenReferences(
      ['doc.md'],
      () => false,
      () => '`src-server/not-real.ts:123-125`',
    );
    expect([...broken.entries()]).toEqual([
      ['src-server/not-real.ts', new Set(['doc.md'])],
    ]);
  });

  it('validates the corrected formerly multiline citation and fails its deletion', () => {
    const corrected = '`packages/sdk/src/queries.ts`';
    expect(
      findBrokenReferences(
        ['doc.md'],
        (path: string) => path === 'packages/sdk/src/queries.ts',
        () => corrected,
      ),
    ).toEqual(new Map());
    expect([
      ...findBrokenReferences(
        ['doc.md'],
        () => false,
        () => corrected,
      ).keys(),
    ]).toEqual(['packages/sdk/src/queries.ts']);
  });

  it('treats every allowlisted path as acceptable', () => {
    for (const path of ALLOWED_MISSING.keys()) {
      expect(typeof ALLOWED_MISSING.get(path)).toBe('string');
      expect(ALLOWED_MISSING.get(path)!.length).toBeGreaterThan(10);
    }
  });
});

describe('the repo’s own live docs', () => {
  it('name no path that does not exist', () => {
    const files = liveDocs();

    const broken = findBrokenReferences(files);
    expect([...broken.keys()]).toEqual([]);
  });
});

describe('live documentation discovery', () => {
  const expectedDirectories = [
    'docs/guides',
    'docs/reference',
    'docs/architecture',
    'docs/patterns',
    'docs/design',
    'docs/contexts',
    'docs/adr',
  ];
  const expectedFiles = [
    'docs/architecture.md',
    'docs/glossary.md',
    'docs/README.md',
    'README.md',
    'AGENTS.md',
    'CONTEXT.md',
    'CONTEXT-MAP.md',
    'SECURITY.md',
  ];
  const regularDirectory = () => ({ isDirectory: () => true });
  const validEntries = [
    'docs/guides/README.md',
    'docs/guides/deep/café notes.md',
    'docs/reference/root.md',
    'docs/architecture/module-map.md',
    'docs/patterns/root.md',
    'docs/design/root.md',
    'docs/contexts/deeper/guide.md',
    'docs/adr/root.md',
    ...expectedFiles,
  ];
  const nulOutput = (entries = validEntries) =>
    Buffer.from(`${entries.join('\0')}\0`);

  it('enumerates every declared directory recursively with NUL-safe tracked Git output', () => {
    const calls: unknown[][] = [];
    const files = liveDocs({
      root: '/repo',
      runGit: (...args: unknown[]) => {
        calls.push(args);
        return nulOutput();
      },
      stat: regularDirectory,
    });

    expect(files).toEqual(validEntries);
    expect(LIVE_DOC_DIRECTORIES).toEqual(expectedDirectories);
    expect(LIVE_DOC_FILES).toEqual(expectedFiles);
    expect(calls).toEqual([
      [
        'git',
        ['ls-files', '-z', '--', ...expectedDirectories, ...expectedFiles],
        { cwd: '/repo', encoding: 'buffer' },
      ],
    ]);
    expect(describeLiveDocScope()).toContain('7 recursive tracked directory');
    expect(describeLiveDocScope()).toContain('8 named file scope');
  });

  it('keeps the Module map in the path-validation scope', () => {
    const broken = findBrokenReferences(['docs/architecture/module-map.md']);
    expect([...broken.keys()]).toEqual([]);
  });

  it('fails red when a required directory is absent or tracked discovery fails', () => {
    expect(() =>
      liveDocs({
        root: '/repo',
        runGit: nulOutput,
        stat: () => {
          throw new Error('missing');
        },
      }),
    ).toThrow("could not inspect required directory 'docs/guides'");
    expect(() =>
      liveDocs({
        root: '/repo',
        runGit: nulOutput,
        stat: () => ({ isDirectory: () => false }),
      }),
    ).toThrow("requires directory 'docs/guides'");
    expect(() =>
      liveDocs({
        root: '/repo',
        runGit: () => {
          throw new Error('git failed');
        },
        stat: regularDirectory,
      }),
    ).toThrow('could not enumerate tracked files');

    const errors: string[] = [];
    expect(
      runDocsReferenceGate({
        discover: () => {
          throw new Error('git failed');
        },
        writeError: (message: string) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors).toEqual([
      '\nFAIL: could not enumerate the required live-document scope.',
    ]);
  });

  it('rejects malformed NUL output and incomplete, duplicate, or out-of-scope discovery', () => {
    const discover = (output: Buffer) =>
      liveDocs({ root: '/repo', runGit: () => output, stat: regularDirectory });

    expect(() =>
      liveDocs({
        root: '/repo',
        runGit: () => 'not-a-buffer',
        stat: regularDirectory,
      }),
    ).toThrow('did not return Buffer output');
    expect(() => discover(Buffer.alloc(0))).toThrow('returned no paths');
    expect(() => discover(Buffer.from('\0'))).toThrow('returned no paths');
    expect(() => discover(Buffer.from(validEntries.join('\0')))).toThrow(
      'missing its terminal NUL',
    );
    expect(() => discover(nulOutput([...validEntries, '']))).toThrow(
      'contains an empty path entry',
    );
    expect(() => discover(nulOutput([...validEntries, 'README.md']))).toThrow(
      "returned duplicate path 'README.md'",
    );
    expect(() =>
      discover(nulOutput(validEntries.filter((file) => file !== 'README.md'))),
    ).toThrow("missing required file 'README.md'");
    expect(() =>
      discover(nulOutput([...validEntries, 'docs/strategy/hidden.md'])),
    ).toThrow("returned out-of-scope path 'docs/strategy/hidden.md'");
    expect(() => discover(Buffer.from([0xff, 0]))).toThrow('not valid UTF-8');
    expect(() =>
      discover(
        nulOutput(
          validEntries.filter((file) => !file.startsWith('docs/contexts/')),
        ),
      ),
    ).toThrow("missing Markdown files for directory 'docs/contexts'");
    for (const path of [
      '/docs/guides/absolute.md',
      'docs\\guides\\windows.md',
      'docs/guides//double.md',
      'docs/guides/./current.md',
      'docs/guides/../strategy/traversal.md',
      'docs/guides/control\nname.md',
    ]) {
      expect(() => discover(nulOutput([...validEntries, path]))).toThrow(
        `returned non-canonical path '${path}'`,
      );
    }
  });
});
