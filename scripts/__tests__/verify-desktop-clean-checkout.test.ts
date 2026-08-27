import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoGitVisibleResidue,
  captureGitVisibleState,
  TAURI_BUILD_COMMAND,
  verifyDesktopCleanCheckout,
  verifyDesktopPrerequisites,
} from '../verify-desktop-clean-checkout.mjs';

const roots: string[] = [];

function git(root: string, args: string[]) {
  execFileSync('git', args, {
    cwd: root,
    windowsHide: true,
    stdio: 'pipe',
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-desktop-checkout-'));
  roots.push(root);
  mkdirSync(join(root, 'src-desktop', 'icons'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'src-desktop', 'tauri.conf.json'),
    JSON.stringify({ bundle: { icon: ['icons/app icon.png'] } }),
  );
  writeFileSync(
    join(root, 'src-desktop', 'Cargo.toml'),
    '[package]\nname="fixture"\n',
  );
  writeFileSync(join(root, 'src-desktop', 'Cargo.lock'), 'version = 4\n');
  writeFileSync(
    join(root, 'config', 'channel-ports.json'),
    '{"schemaVersion":1}\n',
  );
  writeFileSync(join(root, 'scripts', 'channel-ports.mjs'), 'export {};\n');
  writeFileSync(join(root, 'src-desktop', 'icons', 'app icon.png'), 'png');
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'station-test@example.invalid']);
  git(root, ['config', 'user.name', 'Station Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('desktop clean-checkout verifier', () => {
  it('runs the exact accepted Tauri build argument vector', () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = verifyDesktopCleanCheckout(root, {
      buildRunner(_root, command, args) {
        calls.push({ command, args });
        return { status: 0 };
      },
    });
    expect(calls).toEqual([{ command: 'npm', args: TAURI_BUILD_COMMAND }]);
    expect(result.before).toEqual([]);
    expect(result.after).toEqual([]);
  });

  it('allows Tauri to regenerate ignored platform schemas', () => {
    const root = fixture();
    writeFileSync(join(root, '.gitignore'), 'src-desktop/gen/schemas/\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '--quiet', '-m', 'ignore generated schemas']);

    const result = verifyDesktopCleanCheckout(root, {
      buildRunner() {
        const schemaRoot = join(root, 'src-desktop', 'gen', 'schemas');
        mkdirSync(schemaRoot, { recursive: true });
        writeFileSync(join(schemaRoot, 'linux-schema.json'), '{}\n');
        return { status: 0 };
      },
    });

    expect(result.before).toEqual([]);
    expect(result.after).toEqual([]);
  });

  it('fails before building when a configured icon is missing', () => {
    const root = fixture();
    rmSync(join(root, 'src-desktop', 'icons', 'app icon.png'));
    let built = false;
    expect(() =>
      verifyDesktopCleanCheckout(root, {
        buildRunner() {
          built = true;
          return { status: 0 };
        },
      }),
    ).toThrow(/prerequisite is missing.*app icon\.png/s);
    expect(built).toBe(false);
  });

  it('fails before building when a configured icon is not tracked', () => {
    const root = fixture();
    git(root, ['rm', '--cached', '--quiet', 'src-desktop/icons/app icon.png']);
    expect(() => verifyDesktopPrerequisites(root)).toThrow(
      /must be committed to Git.*app icon\.png/s,
    );
  });

  it('rejects a tracked symlink instead of following it as a regular input', () => {
    const root = fixture();
    const iconPath = join(root, 'src-desktop', 'icons', 'app icon.png');
    rmSync(iconPath);
    symlinkSync('../Cargo.toml', iconPath);
    git(root, ['add', 'src-desktop/icons/app icon.png']);
    expect(() => verifyDesktopPrerequisites(root)).toThrow(
      /prerequisite is missing.*app icon\.png/s,
    );
  });

  it('fails before building when Cargo.lock is missing', () => {
    const root = fixture();
    rmSync(join(root, 'src-desktop', 'Cargo.lock'));
    expect(() => verifyDesktopPrerequisites(root)).toThrow(
      /prerequisite is missing.*Cargo\.lock/s,
    );
  });

  it('requires the channel-port contract and generator to be committed', () => {
    const root = fixture();
    git(root, ['rm', '--cached', '--quiet', 'config/channel-ports.json']);
    expect(() => verifyDesktopPrerequisites(root)).toThrow(
      /must be committed to Git.*channel-ports\.json/s,
    );
  });

  it('preserves an unchanged pre-existing dirty state', () => {
    expect(() =>
      assertNoGitVisibleResidue(
        [' M src-desktop/Cargo.toml', '?? notes.txt'],
        [' M src-desktop/Cargo.toml', '?? notes.txt'],
      ),
    ).not.toThrow();
  });

  it('reports new and removed Git-visible residue', () => {
    expect(() =>
      assertNoGitVisibleResidue(
        [' M existing.txt'],
        [' M existing.txt', '?? generated-schema.json'],
      ),
    ).toThrow(/new\/changed.*generated-schema\.json/s);
    expect(() => assertNoGitVisibleResidue(['?? removed.txt'], [])).toThrow(
      /removed\/changed.*removed\.txt/s,
    );
  });

  it('keeps newline-containing filenames as one NUL-delimited entry', () => {
    const root = fixture();
    writeFileSync(join(root, 'generated\nname.json'), 'generated');
    const state = captureGitVisibleState(root);
    expect(state).toEqual(['?? generated\nname.json']);
    expect(() => assertNoGitVisibleResidue(state, state)).not.toThrow();
    expect(() => assertNoGitVisibleResidue([], state)).toThrow(
      /generated\\nname\.json/,
    );
  });
});
