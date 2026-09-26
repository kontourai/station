/**
 * No script may decide it is the entry point by comparing `process.argv[1]`
 * with `import.meta` itself (#2682). `import.meta.url` is realpathed and
 * percent-encoded; `argv[1]` is neither, so a hand-rolled comparison is false
 * from a checkout path with a space or `%` in it, or through a symlink, and
 * the script exits 0 having run nothing. `scripts/lib/module-entry.mjs`'s
 * `invokedDirectly(import.meta.url)` is the one comparison that holds.
 *
 * This reads every tracked code file under the pinned roots with comment
 * lines removed. It is a text scan, not a parse. It sees `process.argv[1]`,
 * `process.argv.at(1)`, and a name bound to either or destructured as the
 * second element (`const [, entry] = process.argv`), wherever that name is
 * later used within two lines of `import.meta`. It does not see an alias of
 * `process.argv` itself (`const a = process.argv; a[1]`), a binding made in
 * another module, or a comparison more than two lines from `import.meta`.
 * The behaviour the helper promises is proven by child processes in
 * `module-entry.test.ts`.
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

const ARGV1 = /process\.argv(?:\[1\]|\.at\(\s*1\s*\))/;
/** `const x = process.argv[1]`, `.at(1)`, or `const [, x] = process.argv`. */
const ARGV1_BINDINGS = [
  /\b(?:const|let|var)\s+(\w+)\s*=\s*process\.argv(?:\[1\]|\.at\(\s*1\s*\))/g,
  /\b(?:const|let|var)\s*\[\s*(?:\w+\s*)?,\s*(\w+)[^\]]*\]\s*=\s*process\.argv(?![\w.[])/g,
];
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
    test: (text) =>
      /process\.argv(?:\[1\]|\.at\(\s*1\s*\))\??\.endsWith\(/.test(text),
  },
  {
    // Any other spelling: argv[1] (or a name bound to it) within two lines
    // of import.meta. The window is centred on that reference.
    rule: 'argv[1] compared with import.meta',
    test: (text) => META.test(text),
  },
];

function findHandRolledEntryGuards(
  source: string,
): Array<{ line: number; rule: string }> {
  const lines = source
    .split('\n')
    .map((line) => (COMMENT_LINE.test(line) ? '' : line));
  const code = lines.join('\n');
  const aliases = ARGV1_BINDINGS.flatMap((binding) =>
    [...code.matchAll(binding)].map((match) => match[1]),
  );
  const reference = aliases.length
    ? new RegExp(`${ARGV1.source}|\\b(?:${aliases.join('|')})\\b`)
    : ARGV1;
  const found: Array<{ line: number; rule: string }> = [];
  lines.forEach((line, index) => {
    if (!reference.test(line)) return;
    const window = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
    const hit = RULES.find(({ test }) => test(window));
    if (hit) found.push({ line: index + 1, rule: hit.rule });
  });
  return found;
}

/**
 * Scripts that run as lone files, away from scripts/lib, so they keep an
 * inline guard instead of importing the helper. Each pins its EXACT guard,
 * through the call that uses it: the main scan still reads the whole file with
 * only that text removed, so any other hand-rolled comparison in it (or an
 * edit to the guard itself) fails. Each entry also re-proves that the
 * lone-file use still exists and, where it is true today, that the file
 * imports nothing relative.
 */
const LONE_FILE_SCRIPTS: Readonly<
  Record<
    string,
    { usedAt: string; use: string; importFree: boolean; guard: string }
  >
> = {
  // Three workflows extract it from the base commit into $RUNNER_TEMP.
  'scripts/classify-ci-change.mjs': {
    usedAt: '.github/workflows/windows-pr-verification.yml',
    use: 'git show "$BASE_SHA:scripts/classify-ci-change.mjs"',
    importFree: true,
    guard: [
      'let isMain = false;',
      'try {',
      '  isMain =',
      "    realpathSync(resolve(process.argv[1] ?? '')) ===",
      '    realpathSync(fileURLToPath(import.meta.url));',
      '} catch {',
      "  // A missing entry path cannot be this module's executable invocation.",
      '}',
      'if (isMain) main(process.argv.slice(2));',
    ].join('\n'),
  },
  // Copied (never symlinked) onto PATH as `station-dev`.
  'scripts/station-dev.mjs': {
    usedAt: 'scripts/install-station-dev.mjs',
    use: "'station-dev.mjs'",
    importFree: true,
    guard: [
      'function isMain() {',
      '  const entry = process.argv[1];',
      '  if (!entry) return false;',
      '  try {',
      '    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));',
      '  } catch {',
      '    return false;',
      '  }',
      '}',
      '',
      'if (isMain()) {',
    ].join('\n'),
  },
  'scripts/station-dogfood-reconcile.mjs': {
    usedAt: 'ops/dogfood/install-macos.zsh',
    use: 'install -m 0755 "$REPO_ROOT/scripts/station-dogfood-reconcile.mjs" "$RUNNER"',
    importFree: true,
    guard: [
      'function invokedDirectly() {',
      '  const entry = process.argv[1];',
      '  if (!entry) return false;',
      '  let real;',
      '  try {',
      '    real = realpathSync(path.resolve(entry));',
      '  } catch (error) {',
      "    if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(error?.code))",
      '      return false;',
      '    throw error;',
      '  }',
      '  return real === realpathSync(fileURLToPath(import.meta.url));',
      '}',
      '',
      'if (invokedDirectly()) {',
    ].join('\n'),
  },
  // Installed alone too, but it ALREADY imports
  // ../packages/shared/src/process-identity.mjs, so the installed copy cannot
  // resolve it. That is a separate, pre-existing defect; this pins only what
  // is true: no module-entry import and its guard as it stands (realpath of
  // argv[1] against the already-realpathed import.meta.url).
  'scripts/station-dogfood-health.mjs': {
    usedAt: 'ops/dogfood/install-macos.zsh',
    use: 'install -m 0755 "$REPO_ROOT/scripts/station-dogfood-health.mjs" "$HEALTH_HELPER"',
    importFree: false,
    guard: [
      'function isMainModule() {',
      '  const entrypoint = process.argv[1];',
      '  if (!entrypoint) return false;',
      '  try {',
      '    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;',
      '  } catch {',
      '    return import.meta.url === pathToFileURL(entrypoint).href;',
      '  }',
      '}',
      '',
      'if (isMainModule()) {',
    ].join('\n'),
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
    const offenders = scannedFiles().flatMap((path) => {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      // Only a lone-file script's exact pinned guard is exempt. Blanked, not
      // deleted, so the reported line numbers stay those of the file.
      const guard = LONE_FILE_SCRIPTS[path]?.guard;
      const scanned =
        guard && source.includes(guard)
          ? source.replace(guard, guard.replace(/[^\n]/g, ' '))
          : source;
      return findHandRolledEntryGuards(scanned).map(
        ({ line, rule }) => `${path}:${line} (${rule})`,
      );
    });
    expect(
      offenders,
      "use `invokedDirectly(import.meta.url)` from scripts/lib/module-entry.mjs; for a script in LONE_FILE_SCRIPTS (which cannot import it), update that entry's pinned `guard` text in this file instead",
    ).toEqual([]);
  });

  test.each(Object.entries(LONE_FILE_SCRIPTS))(
    '%s stays a lone file with a realpath guard',
    (path, { usedAt, use, importFree, guard }) => {
      expect(scannedFiles()).toContain(path);
      const source = readFileSync(join(repoRoot, path), 'utf8');
      expect(readFileSync(join(repoRoot, usedAt), 'utf8')).toContain(use);
      expect(source).not.toMatch(/from\s+['"][^'"]*module-entry\.mjs['"]/);
      if (importFree) expect(RELATIVE_IMPORT.test(source)).toBe(false);
      // The pinned guard, exactly once; the scan above covers the rest.
      expect(
        source.split(guard).length - 1,
        `${path}'s entry guard no longer matches LONE_FILE_SCRIPTS['${path}'].guard in module-entry.scan.test.ts; if the change is intended, update the pinned text (it must still realpath both sides)`,
      ).toBe(1);
      expect(guard).toMatch(/realpathSync\(/);
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
    // Destructured, `.at(1)`, and bound far from the comparison.
    'const [, entry] = process.argv;\nif (resolve(entry) === fileURLToPath(import.meta.url)) main();',
    'const [node, script] = process.argv;\nif (script === fileURLToPath(import.meta.url)) main();',
    'if (import.meta.url === pathToFileURL(process.argv.at(1)).href) main();',
    "if (process.argv.at(1)?.endsWith('x.mjs')) main();",
    'const entry = process.argv[1];\nconst a = 1;\nconst b = 2;\nconst c = 3;\nif (entry === fileURLToPath(import.meta.url)) main();',
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
    // A later positional destructured as data, not the entry path.
    'const [, , command] = process.argv;\nconst here = import.meta.url;',
    // Positional arguments sliced off argv, next to the helper call.
    'if (invokedDirectly(import.meta.url)) {\n  const [app, identity] = process.argv.slice(2);\n}',
  ])('does not flag %s', (source) => {
    expect(findHandRolledEntryGuards(source)).toEqual([]);
  });
});
