import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const installer = join(root, 'ops/nightly/install-macos.zsh');
const dirs = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

function fixture({ foreignLock = false, signalParent = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'station-nightly-cleanup-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const script = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/zsh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  script('uname', '[[ "$1" == -s ]] && print Darwin || print arm64');
  const marker = join(dir, 'child-done');
  const releases = join(dir, 'lock-releases');
  script(
    'npm',
    signalParent
      ? 'kill -TERM $PPID; sleep 0.1; print child-done > "$CHILD_DONE"; exit 91'
      : 'print npm-ran > "$NPM_RAN"; exit 91',
  );
  if (signalParent) {
    script(
      'rmdir',
      'if [[ "$1" == "$LOCK_PATH" ]]; then test -f "$CHILD_DONE" || exit 92; print released >> "$LOCK_RELEASES"; /bin/rmdir "$1"; mkdir "$1"; touch "$1/foreign-owner"; exit 0; fi; /bin/rmdir "$@"',
    );
    script('npx', 'print npx-ran > "$NPX_RAN"; exit 93');
  }
  script(
    'git',
    `
workdir=''
if [[ "$1" == -C ]]; then workdir="$2"; shift 2; fi
if [[ "$1 $2" == 'rev-parse --show-toplevel' ]]; then print "${'$'}{workdir:-${root}}"; exit 0; fi
if [[ "$1 $2" == 'rev-parse --git-common-dir' ]]; then print .git; exit 0; fi
if [[ "$1" == status ]]; then exit 0; fi
if [[ "$1" == fetch || "$1" == checkout ]]; then exit 0; fi
if [[ "$1 $2" == 'rev-parse HEAD' || "$1 $2" == 'rev-parse FETCH_HEAD' || "$1 $2" == 'rev-parse origin/main' ]]; then print ${'a'.repeat(40)}; exit 0; fi
if [[ "$1" == clone ]]; then [[ -z "${'$'}{GIT_LOG:-}" ]] || print "${'$'}{@: -1}" >> "$GIT_LOG"; mkdir -p "${'$'}{@: -1}/.git"; exit 0; fi
if [[ "$1 $2" == 'remote get-url' ]]; then print git@github.com:kontourai/station.git; exit 0; fi
exit 0`,
  );
  const lock = join(home, '.station/cache/nightly/install.lock');
  if (foreignLock) mkdirSync(lock, { recursive: true });
  return {
    dir,
    home,
    bin,
    lock,
    marker,
    releases,
    npmRan: join(dir, 'npm-ran'),
    gitLog: join(dir, 'git.log'),
    output: join(dir, 'out'),
  };
}

describe('build-only installer cleanup', () => {
  it('cleans failed publication once and preserves a subsequently reacquired output', () => {
    const source = readFileSync(installer, 'utf8');
    const cleanup = source.match(/^cleanup\(\) \{[\s\S]*?^\}/m)?.[0];
    const publication = source.match(
      / {2}if ! ditto "\$artifact_app"[\s\S]*?\n {2}fi/,
    )?.[0];
    expect(cleanup).toBeTruthy();
    expect(publication).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'station-publication-cleanup-'));
    dirs.push(dir);
    for (const name of ['out', 'staging', 'lock']) mkdirSync(join(dir, name));
    // Execute the production blocks, with only the failed copier and observed
    // removal replaced. A second removal destroys another owner's marker.
    const harness = `
set -eu
build_only=1; output_owned=1; staging_owned=1; lock_owned=1
output_dir="$CASE_DIR/out"; staging_dir="$CASE_DIR/staging"; lock_dir="$CASE_DIR/lock"
candidate="$CASE_DIR/candidate"; backup="$CASE_DIR/backup"; destination="$CASE_DIR/destination"
artifact_app="$CASE_DIR/artifact"; archive_path="$CASE_DIR/archive"
checksum_path="$CASE_DIR/checksum"; receipt_path="$CASE_DIR/receipt"
ditto() { return 91; }
rm() {
  /bin/rm "$@"
  if [[ "\${@: -1}" == "$output_dir" ]]; then
    print removed >> "$CASE_DIR/removals"
    if [[ ! -e "$CASE_DIR/reacquired" ]]; then
      touch "$CASE_DIR/reacquired"
      mkdir "$output_dir"
      touch "$output_dir/foreign-owner"
    fi
  fi
}
${cleanup}
trap cleanup EXIT
${publication}
exit 99
`;
    let error;
    try {
      execFileSync('zsh', ['-c', harness], {
        env: { ...process.env, CASE_DIR: dir },
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.status).toBe(1);
    expect(readFileSync(join(dir, 'removals'), 'utf8')).toBe('removed\n');
    expect(existsSync(join(dir, 'out/foreign-owner'))).toBe(true);
    expect(existsSync(join(dir, 'staging'))).toBe(false);
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });
  it('removes owned staging and lock after a bounded npm failure', () => {
    const f = fixture();
    expect(() =>
      execFileSync(
        'zsh',
        [installer, '--build-only', '--output-dir', f.output],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: f.home,
            PATH: `${f.bin}:${process.env.PATH}`,
            NPM_RAN: f.npmRan,
            STATION_ROOT: join(f.home, '.station'),
          },
          stdio: 'pipe',
        },
      ),
    ).toThrow();
    expect(
      readdirSync(join(f.home, '.station/cache/nightly/build-only-staging')),
    ).toEqual([]);
    expect(existsSync(f.npmRan)).toBe(true);
    expect(existsSync(f.lock)).toBe(false);
    expect(existsSync(f.output)).toBe(false);
  });
  it('resolves relative STATION_ROOT before changing to the provenance checkout', () => {
    const f = fixture();
    const relativeRoot = 'relative-station-root';
    expect(() =>
      execFileSync(
        'zsh',
        [installer, '--build-only', '--output-dir', f.output],
        {
          cwd: f.dir,
          env: {
            ...process.env,
            GIT_LOG: f.gitLog,
            HOME: f.home,
            NPM_RAN: f.npmRan,
            PATH: `${f.bin}:${process.env.PATH}`,
            STATION_ROOT: `  ${relativeRoot}  `,
          },
          stdio: 'pipe',
        },
      ),
    ).toThrow();
    expect(readFileSync(f.gitLog, 'utf8').trim()).toBe(
      join(
        realpathSync(f.dir),
        relativeRoot,
        'cache',
        'nightly',
        'build-checkout-v2',
      ),
    );
  });
  it('preserves a foreign lock while cleaning its owned staging', () => {
    const f = fixture({ foreignLock: true });
    expect(() =>
      execFileSync(
        'zsh',
        [installer, '--build-only', '--output-dir', f.output],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: f.home,
            PATH: `${f.bin}:${process.env.PATH}`,
            STATION_ROOT: join(f.home, '.station'),
          },
          stdio: 'pipe',
        },
      ),
    ).toThrow();
    expect(existsSync(f.lock)).toBe(true);
    expect(
      readdirSync(join(f.home, '.station/cache/nightly/build-only-staging')),
    ).toEqual([]);
    expect(existsSync(f.output)).toBe(false);
  });
  it('exits once on TERM after its foreground child and preserves a reacquired lock', () => {
    const f = fixture({ signalParent: true });
    let error;
    try {
      execFileSync(
        'zsh',
        [installer, '--build-only', '--output-dir', f.output],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: f.home,
            PATH: `${f.bin}:${process.env.PATH}`,
            CHILD_DONE: f.marker,
            LOCK_PATH: f.lock,
            LOCK_RELEASES: f.releases,
            NPX_RAN: join(f.dir, 'npx-ran'),
            STATION_ROOT: join(f.home, '.station'),
          },
          stdio: 'pipe',
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error?.status).toBe(143);
    expect(existsSync(f.marker)).toBe(true);
    expect(readFileSync(f.releases, 'utf8').trim().split('\n')).toEqual([
      'released',
    ]);
    expect(existsSync(join(f.lock, 'foreign-owner'))).toBe(true);
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(join(f.dir, 'npx-ran'))).toBe(false);
  });
});
