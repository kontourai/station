/**
 * No entry check in the tree is built by turning `process.argv[1]` into a URL
 * string, or by comparing it with `new URL(import.meta.url).pathname`.
 *
 * Those forms compare a native path with URL text. A space in the checkout
 * path is percent-encoded on one side only, and a Windows `C:\...` argv never
 * equals a `file:///C:/...` URL, so the check is false, `main()` never runs,
 * and the script exits 0 having done nothing. That is how
 * `type-laundering-gate.mjs` was a silent no-op in the required Windows
 * portable-floor job. `scripts/lib/module-entry.mjs` (`invokedDirectly`)
 * answers from Node's own `import.meta.main` instead.
 *
 * It also rejects the helper's stale call shape, `invokedDirectly` given
 * `import.meta.url` instead of `import.meta`: a string has no `main`, so that
 * call throws at startup.
 *
 * This is a structural rule, so a structural scan is the proof of it. Why a
 * scan rather than a unit test of the helper: a helper test says nothing
 * about a script that never calls the helper. The scan reads every tracked or untracked, unignored code file, so
 * a new script is scanned before it is committed.
 * `module-entry.process.test.ts` and `type-laundering-gate.process.test.ts`
 * prove the helper's behavior end to end.
 *
 * The scan sees textual forms; an aliased `process.argv` or a URL built in a
 * helper is not caught. It steers authors to `invokedDirectly`; it is not a
 * proof that every entry check is sound.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CODE_PATH = /\.(?:mjs|cjs|js|ts|mts|cts|tsx)$/;

const ARGV1 = String.raw`process\.argv\[1\]`;
const IMPORT_META_PATHNAME = String.raw`new URL\(\s*import\.meta\.url\s*\)\.pathname`;

const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> =
  [
    {
      name: 'a file:// template literal built from argv[1]',
      re: new RegExp(String.raw`file:\/\/\$\{[^\x60]*${ARGV1}`),
    },
    {
      name: 'a file:// prefix concatenated with argv[1]',
      re: new RegExp(String.raw`['"]file:\/\/['"]\s*\+\s*${ARGV1}`),
    },
    {
      name: 'a URL constructed from argv[1]',
      re: new RegExp(String.raw`new URL\(\s*${ARGV1}`),
    },
    {
      name: 'invokedDirectly given import.meta.url instead of import.meta',
      re: /invokedDirectly\(\s*import\.meta\.url\s*\)/,
    },
    {
      name: 'the import.meta.url pathname compared with argv[1]',
      re: new RegExp(
        String.raw`${IMPORT_META_PATHNAME}\s*===\s*${ARGV1}|${ARGV1}\s*===\s*${IMPORT_META_PATHNAME}`,
      ),
    },
  ];

/**
 * Files that carried a forbidden form before this rule and now call
 * `invokedDirectly`. If a pathspec or extension change drops them out of the
 * scanned set, the scan fails instead of passing over a smaller tree.
 */
const SCOPE_SENTINELS = [
  'scripts/type-laundering-gate.mjs',
  'scripts/lib/nightly-build-identity.mjs',
  'ops/release/macos-notarized-artifacts.mjs',
];

/** Whole-line `//` and block-comment lines are prose that names the form. */
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      );
    })
    .join('\n');
}

function forbiddenEntryChecks(source: string): string[] {
  const code = codeLines(source);
  return FORBIDDEN.filter(({ re }) => re.test(code)).map(({ name }) => name);
}

/**
 * Samples are written with `ARGV` for `process.argv[1]`, `META_URL` for
 * `import.meta.url`, and `%{` for a template placeholder, expanded at
 * runtime, so this file does not itself contain the forms it forbids.
 */
const expand = (sample: string) =>
  sample
    .replaceAll('ARGV', ['process', 'argv[1]'].join('.'))
    .replaceAll('%{', '$' + '{')
    .replaceAll('META_URL', ['import', 'meta', 'url'].join('.'));

const TEMPLATE = FORBIDDEN[0].name;
const CONCAT = FORBIDDEN[1].name;
const URL_FROM_ARGV = FORBIDDEN[2].name;
const STALE_CALL = FORBIDDEN[3].name;
const PATHNAME = FORBIDDEN[4].name;

describe('entry checks are not built from process.argv[1] as URL text', () => {
  it.each([
    [
      'template literal',
      'if (import.meta.url === `file://%{ARGV}`) main();',
      TEMPLATE,
    ],
    [
      'template literal around resolve()',
      "if (import.meta.url === `file://%{resolve(ARGV ?? '')}`) main();",
      TEMPLATE,
    ],
    [
      'string concatenation',
      "if (import.meta.url === 'file://' + ARGV) {}",
      CONCAT,
    ],
    [
      'new URL with a file: base',
      "if (import.meta.url === new URL(ARGV, 'file:').href) {}",
      URL_FROM_ARGV,
    ],
    ['stale helper call', 'if (invokedDirectly(META_URL)) main();', STALE_CALL],
    [
      'pathname on the right',
      'if (ARGV === new URL(import.meta.url).pathname) {}',
      PATHNAME,
    ],
    [
      'pathname on the left, across lines',
      'if (ARGV && new URL(import.meta.url).pathname ===\n  ARGV) {}',
      PATHNAME,
    ],
  ])('rejects the %s form', (_name, sample, rule) => {
    expect(forbiddenEntryChecks(expand(sample))).toContain(rule);
  });

  it.each([
    ['the shared helper', 'if (invokedDirectly(import.meta)) main();'],
    [
      'a resolved-path comparison',
      "if (resolve(ARGV ?? '') === fileURLToPath(import.meta.url)) main();",
    ],
    [
      'pathToFileURL',
      'if (import.meta.url === pathToFileURL(resolve(ARGV)).href) main();',
    ],
    [
      'a comment that names the old form',
      '// used to be `import.meta.url === `file://%{ARGV}``\nmain();',
    ],
  ])('accepts %s', (_name, sample) => {
    expect(forbiddenEntryChecks(expand(sample))).toEqual([]);
  });

  it('no tracked or new code file uses a forbidden form', () => {
    // Tracked and untracked-but-not-ignored, so a new script is scanned
    // before it is committed.
    const files = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
    )
      .split('\n')
      .filter((file) => CODE_PATH.test(file));
    for (const sentinel of SCOPE_SENTINELS) expect(files).toContain(sentinel);

    const offenders: string[] = [];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch (error) {
        // Listed by git but deleted in the working tree.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!source.includes('argv[1]') && !source.includes('invokedDirectly'))
        continue;
      for (const name of forbiddenEntryChecks(source)) {
        offenders.push(`${file}: ${name}`);
      }
    }
    expect(
      offenders,
      'use invokedDirectly(import.meta) from scripts/lib/module-entry.mjs',
    ).toEqual([]);
  });
});
