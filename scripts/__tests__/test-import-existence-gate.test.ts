import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  extractValueSpecifiers,
  packageNameOf,
  packageResolvesFrom,
  TEST_FILE_PATTERN,
} from '../test-import-existence-gate.mjs';
import { VITEST_TEST_FILE_PATTERN } from '../verification-policy-gate.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const gatePath = join(repoRoot, 'scripts/test-import-existence-gate.mjs');

describe('extractValueSpecifiers — anchored, not the naive unanchored scan', () => {
  test('captures a plain static import', () => {
    const found = extractValueSpecifiers(
      "import { createCanvas } from 'canvas';\n",
    );
    expect(found.map((f) => f.specifier)).toEqual(['canvas']);
  });

  test('skips a whole `import type` statement — erased before anything runs', () => {
    const found = extractValueSpecifiers(
      "import type { Foo } from 'never-installed-types-only';\n",
    );
    expect(found).toEqual([]);
  });

  test('captures require() and dynamic import() calls', () => {
    const found = extractValueSpecifiers(
      "const x = require('ws');\nconst y = () => import('qrcode');\n",
    );
    expect(found.map((f) => f.specifier).sort()).toEqual(['qrcode', 'ws']);
  });

  test('does NOT capture "from" inside an ordinary assertion/comment string — the regression this gate\'s own history hit', () => {
    // A naive unanchored `from\s+['"]...['"]` scan mis-captured prose like
    // this as an "import specifier", including runaway multi-line captures
    // when a stray apostrophe (e.g. "don't") sat between the intended open
    // and close quotes. Anchoring to real import/export/require syntax must
    // find nothing here.
    const found = extractValueSpecifiers(
      "test('derived from a second, drifted copy', () => {\n" +
        "  // this comment mentions 'from' too, and it's fine\n" +
        "  expect(x).toBe('a value that came from somewhere');\n" +
        '});\n',
    );
    expect(found).toEqual([]);
  });

  test('a mixed `import Foo, { type Bar } from` is a real value import, not type-only', () => {
    const found = extractValueSpecifiers(
      "import Foo, { type Bar } from 'real-value-import';\n",
    );
    expect(found.map((f) => f.specifier)).toEqual(['real-value-import']);
  });
});

describe('packageNameOf', () => {
  test('scoped package with subpath reduces to the two-segment scope/name', () => {
    expect(packageNameOf('@kontourai/flow-agents/kits/foo.js')).toBe(
      '@kontourai/flow-agents',
    );
  });

  test('unscoped package with subpath reduces to its first segment', () => {
    expect(packageNameOf('ajv/dist/2020.js')).toBe('ajv');
  });

  test('bare specifier is unchanged', () => {
    expect(packageNameOf('jsqr')).toBe('jsqr');
  });
});

describe('packageResolvesFrom', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function scratchDir() {
    const root = mkdtempSync(join(tmpdir(), 'station-test-import-existence-'));
    roots.push(root);
    return root;
  }

  test('finds a package installed several directories up (workspace hoisting)', () => {
    const root = scratchDir();
    mkdirSync(join(root, 'node_modules/some-hoisted-pkg'), {
      recursive: true,
    });
    const deepDir = join(root, 'a/b/c');
    mkdirSync(deepDir, { recursive: true });
    // Explicit `null` — station#3423 review LOW-2: `boundaryRoot` has no
    // default, so an unbounded walk must be requested, never inherited by
    // omitting the argument.
    expect(packageResolvesFrom(deepDir, 'some-hoisted-pkg', null)).toBe(true);
  });

  test('a package that exists nowhere on the walk is unresolved', () => {
    const root = scratchDir();
    mkdirSync(root, { recursive: true });
    expect(
      packageResolvesFrom(root, 'definitely-not-installed-xyz', null),
    ).toBe(false);
  });

  // Both-directions proof (per this repo's fault-injection discipline): a
  // real installed package resolves, and removing it makes the SAME check
  // fail — the guard is bound to actual presence, not a hardcoded allowlist.
  test('bound both directions: installing then removing the package flips the result', () => {
    const root = scratchDir();
    const pkgDir = join(root, 'node_modules/flip-me');
    mkdirSync(pkgDir, { recursive: true });
    expect(packageResolvesFrom(root, 'flip-me', null)).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
    expect(packageResolvesFrom(root, 'flip-me', null)).toBe(false);
  });

  test('omitting boundaryRoot throws instead of silently walking unbounded (station#3423 review LOW-2)', () => {
    const root = scratchDir();
    const deepDir = join(root, 'a/b');
    mkdirSync(deepDir, { recursive: true });
    // No package anywhere on the walk, so the loop must reach the
    // (missing) boundary check and throw on `path.resolve(undefined)`
    // rather than silently returning `false` from an unbounded walk.
    // Tightened to the specific error `path.resolve(undefined)` actually
    // raises (station#3435 review NIT): a bare `.toThrow()` would also
    // pass if `packageResolvesFrom` started throwing for an unrelated
    // reason (e.g. a bug that always throws), which proves nothing about
    // the missing-boundary path specifically.
    expect(() => packageResolvesFrom(deepDir, 'never-installed-xyz')).toThrow(
      TypeError,
    );
  });
});

// Real-child-process coverage of the gate's own reject path (the class of
// gap this repo's delivery protocol names explicitly: "a guardrail whose
// rejection path has never executed is unproven" — a test that only
// exercises the pure detectors above never proves `main()`'s exit code,
// FAIL formatting, or the `--root`/git-ls-files wiring actually work).
describe('the gate as a real child process', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function scratchRepo() {
    const root = mkdtempSync(
      join(tmpdir(), 'station-test-import-existence-repo-'),
    );
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'gate-fixture@example.com'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.name', 'Gate Fixture'], {
      cwd: root,
    });
    return root;
  }

  function runGate(root: string) {
    const result = spawnSync(process.execPath, [gatePath, '--root', root], {
      encoding: 'utf8',
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }

  test('positive control: a scratch repo whose test file imports an installed package passes', () => {
    const root = scratchRepo();
    mkdirSync(join(root, 'node_modules/installed-fixture-pkg'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'good.test.ts'),
      "import { thing } from 'installed-fixture-pkg';\nthing();\n",
    );
    execFileSync('git', ['add', '-A'], { cwd: root });

    const { status, output } = runGate(root);
    expect(status).toBe(0);
    expect(output).toContain('OK:');
  });

  test('negative control: a scratch repo whose test file imports a never-installed package fails by name, file, and line', () => {
    const root = scratchRepo();
    writeFileSync(
      join(root, 'bad.test.ts'),
      "// leading comment line\nimport { thing } from 'totally-unresolvable-fixture-pkg-xyz';\n",
    );
    execFileSync('git', ['add', '-A'], { cwd: root });

    const { status, output } = runGate(root);
    expect(status).toBe(1);
    expect(output).toContain('FAIL:');
    expect(output).toContain('bad.test.ts:2');
    expect(output).toContain('totally-unresolvable-fixture-pkg-xyz');
  });

  test('positive control: the real repository passes today (station#3423 fixed the one prior offender)', () => {
    // Independently derived from `git ls-files`, NOT via the gate's own
    // `listTrackedTestFiles` — a scope bug added inside that function (e.g.
    // an accidental `packages/**` exclusion) must move the gate's printed
    // count away from this independently-computed figure, or the gate could
    // silently drop hundreds of files and still print a confident `OK:`
    // (station#3423 review MEDIUM-1: reproduced live, 1759 -> 1469 files,
    // 290 dropped including qr-round-trip.test.ts itself, exit 0 throughout).
    const trackedFiles = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    const expectedCount = trackedFiles.filter(
      (file) =>
        existsSync(join(repoRoot, file)) && TEST_FILE_PATTERN.test(file),
    ).length;
    expect(expectedCount).toBeGreaterThan(0);

    const { status, output } = runGate(repoRoot);
    expect(status).toBe(0);
    expect(output).toContain('OK:');
    expect(output).toContain(
      `OK: every statically-extractable bare import in ${expectedCount} test file(s) resolves to an installed package.`,
    );
  });

  // The count check above derives `expectedCount` from `TEST_FILE_PATTERN` —
  // the SAME predicate `listTrackedTestFiles` filters with — so it proves the
  // gate's git-ls-files-plus-filter plumbing is wired correctly, but has zero
  // power over the predicate itself: a `TEST_FILE_PATTERN` narrowed to drop a
  // real extension would shrink the "expected" side and the gate's actual
  // side identically, and the test would stay green while both silently
  // dropped the same files (station#3435 review MEDIUM-1 — the tautology
  // moved up a level rather than closing). Cross-check against
  // `VITEST_TEST_FILE_PATTERN`: a pre-existing, independently declared,
  // strictly broader test-file predicate `verification-policy-gate.mjs`
  // already uses to discover this repo's tracked Vitest corpus for an
  // unrelated gate (the resource-manifest partition check). Every tracked
  // path must classify identically under both, so a narrowing of either
  // predicate alone reds this test by name, file, and pattern — it cannot
  // hide behind a re-derivation that shares the bug.
  test('TEST_FILE_PATTERN classifies every tracked path identically to the independent VITEST_TEST_FILE_PATTERN oracle (station#3435 review MEDIUM-1)', () => {
    const trackedFiles = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(trackedFiles.length).toBeGreaterThan(0);

    const mismatches = trackedFiles.filter(
      (file) =>
        TEST_FILE_PATTERN.test(file) !== VITEST_TEST_FILE_PATTERN.test(file),
    );
    expect(mismatches).toEqual([]);
  });

  // A guardrail whose rejection path never executes is unproven, and this
  // one specifically must not depend on `node_modules` OUTSIDE the tree
  // being gated: this repo's standard layout nests every worktree under a
  // parent checkout that has its own `node_modules` (~80 worktrees today),
  // so an unbounded upward walk from a worktree can silently resolve a
  // package that only the PARENT checkout has installed — a false green in
  // exactly the place a developer runs this gate. Reproduces that shape
  // directly: an outer directory supplies the package via its own
  // `node_modules`, and a git repo nested inside it (the thing actually
  // gated, via `--root`) does not. Bound both directions per this repo's
  // fault-injection discipline: the outer install alone must not satisfy
  // the gate once it is scoped to the inner repo.
  test('does not resolve a package that only exists ABOVE the gated --root (outside the worktree being gated)', () => {
    const outer = mkdtempSync(
      join(tmpdir(), 'station-test-import-existence-outer-'),
    );
    roots.push(outer);
    mkdirSync(join(outer, 'node_modules/outside-only-fixture-pkg'), {
      recursive: true,
    });

    const nested = join(outer, 'nested-repo');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested });
    execFileSync('git', ['config', 'user.email', 'gate-fixture@example.com'], {
      cwd: nested,
    });
    execFileSync('git', ['config', 'user.name', 'Gate Fixture'], {
      cwd: nested,
    });
    writeFileSync(
      join(nested, 'bad.test.ts'),
      "import { thing } from 'outside-only-fixture-pkg';\nthing();\n",
    );
    execFileSync('git', ['add', '-A'], { cwd: nested });

    const { status, output } = runGate(nested);
    expect(status).toBe(1);
    expect(output).toContain('FAIL:');
    expect(output).toContain('outside-only-fixture-pkg');
  });

  // The entrypoint guard used to be a raw
  // `import.meta.url === \`file://${process.argv[1]}\`` string compare.
  // `import.meta.url` percent-encodes a space in the path; `process.argv[1]`
  // does not — so invoking the gate from (or through) a path containing a
  // space silently no-ops: `main()` never runs, nothing prints, exit stays
  // 0 regardless of findings. Copies the real gate script into a directory
  // whose name contains a space and runs it against a repo with a known-bad
  // import: this must still FAIL loudly, not exit 0 with no output. Both
  // the script's own directory and the gated repo are realpath'd first so a
  // macOS `/tmp` → `/private/tmp` symlink (which Node also resolves when
  // computing `import.meta.url`) cannot masquerade as the space bug.
  test('entrypoint guard still runs when invoked from a path containing a space', () => {
    const base = realpathSync(
      mkdtempSync(join(tmpdir(), 'station-gate-entrypoint-')),
    );
    roots.push(base);
    const spaceDir = join(base, 'has a space');
    mkdirSync(spaceDir, { recursive: true });
    const scriptCopy = join(spaceDir, 'test-import-existence-gate.mjs');
    copyFileSync(gatePath, scriptCopy);

    const root = scratchRepo();
    writeFileSync(
      join(root, 'bad.test.ts'),
      "import { thing } from 'totally-unresolvable-fixture-pkg-xyz';\n",
    );
    execFileSync('git', ['add', '-A'], { cwd: root });

    const result = spawnSync(
      process.execPath,
      [scriptCopy, '--root', realpathSync(root)],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('FAIL:');
  });
});
