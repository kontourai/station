/**
 * No script may decide it is the entry point by comparing `process.argv[1]`
 * with `import.meta` itself (#2682). `import.meta.url` is realpathed and
 * percent-encoded; `argv[1]` is neither, so a hand-rolled comparison is false
 * from a checkout path with a space or `%` in it, or through a symlink, and
 * the script exits 0 having run nothing. `scripts/lib/module-entry.mjs`'s
 * `invokedDirectly(import.meta.url)` is the one comparison that holds.
 *
 * This reads every tracked code file under the pinned roots with comment
 * lines removed. It is a text scan, not a parse: a guard spelled through an
 * alias (`const a = process.argv; a[1]`) is invisible to it. The behaviour
 * the helper promises is proven by child processes in `module-entry.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

/** Where entry-point scripts live. Pinned independently below. */
const SCAN_ROOTS = ['scripts', 'ops'];

const CODE_PATH = /\.[cm]?[jt]sx?$/;
/** Test sources quote the bad forms as fixtures on purpose. */
const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

const ARGV1 = /process\.argv\[1\]/;
const META = /import\.meta\.(url|filename|dirname)\b/;
const RULES: ReadonlyArray<{
  rule: string;
  test: (window: string) => boolean;
}> = [
  {
    rule: 'file:// template around argv[1]',
    test: (text) => /`file:\/\/\$\{[^`]*process\.argv\[1\]/.test(text),
  },
  {
    rule: 'pathToFileURL(argv[1])',
    test: (text) =>
      /pathToFileURL\(\s*(?:[\w.]*resolve\(\s*)?process\.argv\[1\]/.test(text),
  },
  {
    rule: 'argv[1] suffix match',
    test: (text) => /process\.argv\[1\]\??\.endsWith\(/.test(text),
  },
  {
    // Any other spelling: argv[1] within three lines of import.meta.
    rule: 'argv[1] compared with import.meta',
    test: (text) => ARGV1.test(text) && META.test(text),
  },
];

function findHandRolledEntryGuards(
  source: string,
): Array<{ line: number; rule: string }> {
  const lines = source
    .split('\n')
    .map((line) => (COMMENT_LINE.test(line) ? '' : line));
  const found: Array<{ line: number; rule: string }> = [];
  lines.forEach((line, index) => {
    if (!ARGV1.test(line)) return;
    const window = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
    const hit = RULES.find(({ test }) => test(window));
    if (hit) found.push({ line: index + 1, rule: hit.rule });
  });
  return found;
}

/**
 * Scripts that must stay importless because they run as lone files, whose
 * inline guard already realpaths both sides. Each entry is re-proven below:
 * still flagged (or the entry is stale), still import-free, still realpath,
 * and the lone-file use still exists.
 */
const LONE_FILE_SCRIPTS: Readonly<
  Record<string, { usedAt: string; use: string }>
> = {
  'scripts/classify-ci-change.mjs': {
    usedAt: '.github/workflows/windows-pr-verification.yml',
    use: 'git show "$BASE_SHA:scripts/classify-ci-change.mjs"',
  },
};
const RELATIVE_IMPORT = /\bfrom\s+['"]\.\.?\/|\bimport\(\s*['"]\.\.?\//;

function scannedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter((path) => CODE_PATH.test(path) && !TEST_PATH.test(path));
}

describe('entry-point guards use invokedDirectly (#2682)', () => {
  test('scans the entry-point roots, and only tracked non-test code', () => {
    expect(SCAN_ROOTS).toEqual(['scripts', 'ops']);
    const files = scannedFiles();
    // Sentinels from each root and from the helper's own directory: a root
    // that silently stops matching cannot report a vacuous pass.
    for (const sentinel of [
      'scripts/docs-reference-gate.mjs',
      'scripts/lib/module-entry.mjs',
      'scripts/check-kontour-dependency-drift.ts',
      'ops/nightly/macos-signing-identity.mjs',
      'ops/release/macos-signing-readiness.mjs',
    ])
      expect(files).toContain(sentinel);
    expect(files.some((path) => TEST_PATH.test(path))).toBe(false);
  });

  test('no tracked script compares argv[1] with import.meta by hand', () => {
    const offenders = scannedFiles()
      .filter((path) => !(path in LONE_FILE_SCRIPTS))
      .flatMap((path) =>
        findHandRolledEntryGuards(
          readFileSync(join(repoRoot, path), 'utf8'),
        ).map(({ line, rule }) => `${path}:${line} (${rule})`),
      );
    expect(
      offenders,
      'use `invokedDirectly(import.meta.url)` from scripts/lib/module-entry.mjs',
    ).toEqual([]);
  });

  test.each(Object.entries(LONE_FILE_SCRIPTS))(
    '%s stays a lone file with a realpath guard',
    (path, { usedAt, use }) => {
      expect(scannedFiles()).toContain(path);
      const source = readFileSync(join(repoRoot, path), 'utf8');
      expect(
        findHandRolledEntryGuards(source).length,
        'stale entry',
      ).toBeGreaterThan(0);
      expect(RELATIVE_IMPORT.test(source)).toBe(false);
      expect(
        source.match(/realpathSync\(/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(2);
      expect(readFileSync(join(repoRoot, usedAt), 'utf8')).toContain(use);
    },
  );

  // Each form that was on main before #2682, verbatim in shape. The scan is
  // only as good as these: a rule that stops matching fails here.
  test.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a bad guard, not a template
    'if (import.meta.url === `file://${process.argv[1]}`) main();',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a bad guard, not a template
    "if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`)",
    "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {",
    'if (\n  process.argv[1] &&\n  import.meta.url === pathToFileURL(resolve(process.argv[1])).href\n) {',
    "if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))",
    'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {',
    'if (process.argv[1] === new URL(import.meta.url).pathname) {',
    'if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)',
    "if (process.argv[1]?.endsWith('actionlint-gate.mjs')) {",
    'const invokedUrl = process.argv[1]\n  ? pathToFileURL(resolve(process.argv[1])).href\n  : null;\nif (import.meta.url === invokedUrl) {',
    "if (\n  process.argv[1] &&\n  join(\n    fileURLToPath(new URL('.', import.meta.url)),\n    'x.mjs',\n  ) === process.argv[1]\n) {",
    'function isMainModule() {\n  try {\n    return (\n      process.argv[1] &&\n      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)\n    );',
  ])('flags %s', (source) => {
    expect(findHandRolledEntryGuards(source).length).toBeGreaterThan(0);
  });

  test.each([
    'if (invokedDirectly(import.meta.url)) main();',
    // A comment describing the bad form is not a guard.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a bad guard, not a template
    '// never `import.meta.url === `file://${process.argv[1]}``',
    // argv[1] as data, far from any import.meta.
    'const pty = require(process.argv[1]);\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst here = import.meta.url;',
  ])('does not flag %s', (source) => {
    expect(findHandRolledEntryGuards(source)).toEqual([]);
  });
});
