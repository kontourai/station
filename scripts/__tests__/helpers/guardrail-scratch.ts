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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';

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
  files,
  git: useGit = true,
}: ScratchOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-guardrail-fixture-'));
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
): GuardrailResult {
  const result = spawnSync(process.execPath, [join('scripts', script)], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}
