/**
 * The scratch-repo harness both guardrail process-boundary suites run on.
 *
 * Extracted from `guardrail-known-bad-fixtures.test.ts` (station#1555) when
 * `guardrail-process-boundary.test.ts` needed the same machinery. A
 * byte-identical second copy of a mechanism is a defect class this repo has
 * shipped before — one copy gets fixed and the other keeps the bug — so the
 * two suites share this module rather than each carrying their own.
 *
 * What it provides, and why each part exists, is documented on the members
 * below. The short version: guardrails scope themselves with `git ls-files`
 * or `git grep`, so proving one bites requires a real repository, not a loose
 * directory; and the executed bytes must be the production guardrail's, or a
 * fault injection into the real script would not reach the fixture and the
 * binding is fiction.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect } from 'vitest';

/**
 * Every scratch directory this module has made, so they can be removed.
 *
 * `mkdtempSync` does not clean up after itself, and each case here makes one:
 * the two suites left ~40 per run and $TMPDIR had accumulated 3,014 of them
 * (9.5 GB) before anyone looked. A harness that quietly grows the developer's
 * temp directory forever is a cost the tests impose on everything else
 * running on the host.
 */
const scratchDirectories: string[] = [];

/**
 * Keep the trees for inspection. Set `STATION_KEEP_GUARDRAIL_SCRATCH=1` when
 * a case fails and the question is what the guardrail actually walked; the
 * paths are printed so they can be found without guessing.
 */
const KEEP = process.env.STATION_KEEP_GUARDRAIL_SCRATCH === '1';

/**
 * Remove them. Registered here rather than left to each suite's own
 * `afterAll`, so a third suite importing this harness cannot forget — the
 * failure mode would be silent and identical to the one being fixed.
 */
export function cleanupGuardrailScratch(): void {
  if (KEEP) {
    if (scratchDirectories.length > 0) {
      // Straight to the stream: vitest captures `console.*` from an
      // `afterAll` hook and the message did not survive the focused runner,
      // which would have left this promising paths it never printed.
      process.stderr.write(
        `[guardrail-scratch] STATION_KEEP_GUARDRAIL_SCRATCH=1; keeping ${scratchDirectories.length} tree(s):\n  ${scratchDirectories.join('\n  ')}\n`,
      );
    }
    scratchDirectories.length = 0;
    return;
  }
  // `force` so a case that already removed its own tree is not an error, and
  // a failure to remove one never turns a passing suite red: cleanup is
  // hygiene, not a verdict on the code under test.
  while (scratchDirectories.length > 0) {
    const dir = scratchDirectories.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

afterAll(cleanupGuardrailScratch);

export interface ScratchOptions {
  /** Guardrail script basename under `scripts/`, e.g. `state-primitives-ratchet.mjs`. */
  script: string;
  /** Sibling modules the script imports from `scripts/lib/`. */
  libs?: string[];
  /**
   * Further production files under `scripts/` the case needs — a second
   * script the guardrail shells out to, or the baseline JSON it resolves
   * relative to its own `import.meta.url`. Copied under the same
   * byte-equality assertion as `script`, so a case can never silently run
   * against a hand-written stand-in for production data.
   */
  extraScripts?: string[];
  /**
   * Production files copied in VERBATIM by their repo-relative path, under
   * the same byte-equality assertion as `script`. Use this when a gate needs
   * real repository data to get past its own preconditions and reach the
   * check under test — `channel-ports.mjs` reads `config/channel-ports.json`
   * at module top level, so without it the process dies at import and the
   * gate's actual check never runs.
   */
  productionFiles?: readonly string[];
  /** Repo-relative path -> content, materialised and committed. */
  files: Record<string, string | Buffer>;
  /**
   * Skip `git init`/`add`/`commit`. Only for guardrails that do not scope
   * themselves with git — `ui-bundle-budget.mjs` reads a build directory
   * straight off the filesystem and `check-mobile-permissions.mjs` walks
   * `src-desktop/gen` with `readdirSync`, so for those a repository would be
   * scaffolding noise. Defaults to a real repo, which is what the
   * `git ls-files`-scoped majority need.
   */
  git?: boolean;
}

/**
 * A throwaway directory carrying the guardrail and a tree for it to walk,
 * `git init`ed and committed unless `git: false`.
 *
 * The path comes from `mkdtempSync` under the OS temp dir, which on macOS is
 * already symlink-resolved. That matters: several guardrails guard `main()`
 * with `import.meta.url === ` + backtick + `file://${process.argv[1]}`, a byte
 * comparison with no realpath and no URL escaping. Spawning them with the
 * RELATIVE `scripts/<name>.mjs` (as `runGuardrail` does) keeps that comparison
 * true; passing an absolute unresolved path would make the guard silently
 * false and the gate would exit 0 having done nothing.
 */
export function scratchRepo({
  script,
  libs = [],
  extraScripts = [],
  productionFiles = [],
  files,
  git: useGit = true,
}: ScratchOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-guardrail-fixture-'));
  scratchDirectories.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });

  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join('scripts', script), join(dir, 'scripts', script));
  // The executed bytes must be the production guardrail's, or fault-injecting
  // the real script would not reach this fixture and the binding is fiction.
  expect(readFileSync(join(dir, 'scripts', script), 'utf8')).toBe(
    readFileSync(join('scripts', script), 'utf8'),
  );
  for (const lib of libs) {
    copyFileSync(join('scripts', 'lib', lib), join(dir, 'scripts', 'lib', lib));
  }
  for (const extra of extraScripts) {
    copyFileSync(join('scripts', extra), join(dir, 'scripts', extra));
    expect(readFileSync(join(dir, 'scripts', extra), 'utf8')).toBe(
      readFileSync(join('scripts', extra), 'utf8'),
    );
  }

  for (const production of productionFiles) {
    const target = join(dir, production);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(production, target);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(production, 'utf8'));
  }

  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  if (useGit) {
    git('init', '-q');
    git('config', 'user.email', 'guardrail@test.invalid');
    git('config', 'user.name', 'guardrail fixture');
    git('config', 'core.hooksPath', '/dev/null');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fixture');
  }
  return dir;
}

export interface GuardrailResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Both streams, because the guardrails split FAIL/OK across them. */
  output: string;
}

export function runGuardrail(
  dir: string,
  script: string,
  env: Record<string, string> = {},
  /**
   * Arguments the production lane passes. Dropping them is not neutral: every
   * one of these gates branches on `process.argv`, so a no-arg run can
   * exercise a DIFFERENT mode than the one the chain composes — for
   * `generate-issue-lifecycle-reference.mjs` the difference is check versus
   * generate, i.e. reading a file versus writing one.
   */
  args: readonly string[] = [],
): GuardrailResult {
  const result = spawnSync(
    process.execPath,
    [join('scripts', script), ...args],
    {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

/**
 * Import the guardrail as an ordinary module rather than running it as the
 * entry point, so `process.argv[1]` is not the script and every one of these
 * gates' `import.meta.url === file://${process.argv[1]}`-style guards is
 * false.
 *
 * This is what makes "the failure came from behind the entry guard" a
 * computed claim instead of a comment: a diagnostic that appears here as well
 * as under `runGuardrail` was produced at import time and says nothing about
 * whether `main()` ran.
 */
export function importGuardrail(
  dir: string,
  script: string,
  env: Record<string, string> = {},
): GuardrailResult {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import('./scripts/${script}');`],
    {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}
