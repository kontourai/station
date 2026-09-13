import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The gate's REJECTION path, executed as a real child process.
 *
 * A guardrail whose failure branch has never run is unproven: the pure
 * helpers can be right while the script exits 0 anyway, because
 * `process.exitCode = 1` and a thrown error do not behave identically under
 * every invocation. Everything here asserts an observed exit status, not a
 * return value.
 *
 * The fixture is a throwaway git repository rather than the real tree, so the
 * failure cases never mutate a worktree a sibling lane might be holding.
 */

const SCRIPT = join(process.cwd(), 'scripts/ui-glyph-coverage-ratchet.mjs');

const FONTS_CSS = [
  '@font-face {',
  '  font-family: "DM Sans";',
  '  unicode-range: U+0000-00FF, U+2000-206F, U+2212;',
  '}',
  '@font-face {',
  '  font-family: "DM Sans";',
  '  unicode-range: U+0100-02BA, U+2113;',
  '}',
  '@font-face {',
  '  font-family: "JetBrains Mono";',
  '  unicode-range: U+0000-00FF, U+2000-206F, U+2212;',
  '}',
  '@font-face {',
  '  font-family: "JetBrains Mono";',
  '  unicode-range: U+0100-02BA, U+2113;',
  '}',
  '',
].join('\n');

const ALLOWLIST = {
  categories: { icon: { reason: 'a written reason' } },
  codepoints: [{ codepoint: 'U+2605', character: '★', category: 'icon' }],
};

// The real gate's SCOPE_SENTINELS, which the fixture has to satisfy for the
// scan-scope assertion to pass.
const SENTINELS = [
  'src-ui/src/components/badges/GitBadge.tsx',
  'src-ui/src/contexts/KeyboardShortcutsContext.tsx',
  'src-ui/src/index.css',
];

let repo: string;

function write(relative: string, content: string) {
  const path = join(repo, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  execFileSync('git', ['-C', repo, 'add', '--', relative], {
    windowsHide: true,
  });
}

function run() {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ui-glyph-coverage-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet'], { windowsHide: true });
  write('src-ui/src/fonts.css', FONTS_CSS);
  write(
    'scripts/ui-glyph-coverage-allowlist.json',
    `${JSON.stringify(ALLOWLIST, null, 2)}\n`,
  );
  for (const sentinel of SENTINELS) write(sentinel, '/* placeholder */\n');
  // The one declared occurrence, so the baseline fixture has no stale entry.
  write('src-ui/src/Declared.tsx', 'export const a = <p>★</p>;\n');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('the gate exits 0 on a tree whose glyphs are all declared', () => {
  it('reports the declared count and succeeds', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 undeclared');
  });
});

describe('the gate exits non-zero on an undeclared codepoint', () => {
  afterAll(() => {
    rmSync(join(repo, 'src-ui/src/Added.tsx'), { force: true });
    execFileSync(
      'git',
      ['-C', repo, 'rm', '--cached', '--quiet', '--', 'src-ui/src/Added.tsx'],
      {
        windowsHide: true,
      },
    );
  });

  it('fails, and names the file and the line the glyph is on', () => {
    write('src-ui/src/Added.tsx', 'export const a = (\n  <p>●</p>\n);\n');
    const result = run();

    // The observed process status, not a returned value.
    expect(result.status).toBe(1);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('src-ui/src/Added.tsx:2:');
    expect(result.stderr).toContain('U+25CF');
    expect(result.stderr).toContain('ui-glyph-coverage gate failed');
  });

  it('does not fail on the same glyph inside a comment', () => {
    write('src-ui/src/Added.tsx', 'export const a = 1; // ●\n');
    const result = run();
    expect(result.status).toBe(0);
  });
});

describe('the gate exits non-zero on an allowlist entry nothing uses', () => {
  it('names the codepoint and asks for the entry to be removed', () => {
    write(
      'scripts/ui-glyph-coverage-allowlist.json',
      `${JSON.stringify(
        {
          ...ALLOWLIST,
          codepoints: [
            ...ALLOWLIST.codepoints,
            { codepoint: 'U+25CB', character: '○', category: 'icon' },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('U+25CB');
    expect(result.stderr).toContain('remove the entry');

    write(
      'scripts/ui-glyph-coverage-allowlist.json',
      `${JSON.stringify(ALLOWLIST, null, 2)}\n`,
    );
    expect(run().status).toBe(0);
  });
});

describe('the gate refuses to run on a coverage parse it cannot trust', () => {
  it('fails rather than passing vacuously when a wildcard covers everything', () => {
    write(
      'src-ui/src/fonts.css',
      FONTS_CSS.replace(
        /unicode-range: U\+0000-00FF[^;]*;/,
        'unicode-range: U+0000-FFFF;',
      ),
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('vacuous green');

    write('src-ui/src/fonts.css', FONTS_CSS);
    expect(run().status).toBe(0);
  });

  it('fails when a scanned sentinel file falls out of scope', () => {
    execFileSync(
      'git',
      ['-C', repo, 'rm', '--cached', '--quiet', '--', 'src-ui/src/index.css'],
      { windowsHide: true },
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scan scope is broken');
    expect(result.stderr).toContain('src-ui/src/index.css');

    write('src-ui/src/index.css', '/* placeholder */\n');
    expect(run().status).toBe(0);
  });
});

describe('the gate as it is actually wired', () => {
  it('passes against this repository', () => {
    // Binds the fixture cases above to the tree the gate really runs on: a
    // green fixture and a red repository would be the failure this file
    // exists to make impossible to miss.
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
