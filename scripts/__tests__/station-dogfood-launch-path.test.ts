import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureLoginShellPath,
  isTrustedClientMetadata,
  materializeClientShims,
  resolveSupportedClients,
  restoreClientShims,
  SUPPORTED_CLIENT_COMMANDS,
  sanitizePath,
  snapshotClientShims,
} from '../station-dogfood-launch-path.mjs';

const roots: string[] = [];
const LOGIN_SHELL_PATH_TIMEOUT_MS = 5_000;
const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

const fixtureRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'station-client-path-'));
  roots.push(root);
  return root;
};

const executable = (directory: string, name: string, marker = name) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s' ${JSON.stringify(marker)}\n`, {
    mode: 0o700,
  });
  return file;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('Station dogfood client launch path', () => {
  it('keeps safe real directories in first-seen order and explains rejections', () => {
    const root = fixtureRoot();
    const safe = path.join(root, 'safe path & tools');
    const unsafe = path.join(root, 'unsafe');
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);

    const result = sanitizePath(
      [safe, '', 'relative', path.join(root, 'missing'), unsafe, safe].join(
        ':',
      ),
    );
    expect(result.accepted).toEqual([realpathSync(safe)]);
    expect(result.rejected.map(({ reason }) => reason)).toEqual([
      'empty',
      'not-absolute',
      'missing',
      'group-writable',
      'duplicate',
    ]);
  });

  it('resolves only canonical clients with first-directory precedence', () => {
    const root = fixtureRoot();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const selected = executable(first, 'codex', 'first');
    executable(second, 'codex', 'second');
    executable(second, 'unrelated', 'nope');
    const claude = executable(second, 'claude');

    expect(resolveSupportedClients([first, second])).toEqual({
      claude: realpathSync(claude),
      codex: realpathSync(selected),
    });
    expect(SUPPORTED_CLIENT_COMMANDS).toEqual([
      'claude',
      'codex',
      'kiro-cli',
      'cursor-agent',
      'opencode',
    ]);
  });

  it('rejects group-writable PATH entries and writable resolved targets', () => {
    const root = fixtureRoot();
    const groupWritablePath = path.join(root, 'group-writable-path');
    mkdirSync(groupWritablePath, { mode: 0o770 });
    chmodSync(groupWritablePath, 0o770);
    expect(sanitizePath(groupWritablePath).rejected[0]?.reason).toBe(
      'group-writable',
    );

    const safe = path.join(root, 'safe');
    const writableTargets = path.join(root, 'writable-targets');
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(writableTargets, { mode: 0o770 });
    chmodSync(writableTargets, 0o770);
    const target = executable(writableTargets, 'payload');
    chmodSync(writableTargets, 0o770);
    symlinkSync(target, path.join(safe, 'codex'));
    expect(resolveSupportedClients([safe])).toEqual({});

    chmodSync(writableTargets, 0o700);
    chmodSync(target, 0o720);
    expect(resolveSupportedClients([safe])).toEqual({});
    expect(isTrustedClientMetadata({ uid: 50_001, mode: 0o700 }, 501)).toBe(
      false,
    );
    expect(isTrustedClientMetadata({ uid: 0, mode: 0o755 }, 501)).toBe(true);
    expect(isTrustedClientMetadata({ uid: 501, mode: 0o720 }, 501)).toBe(false);
  });

  it('keeps the installer allowlist aligned with provider command definitions', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const defaults = readFileSync(
      path.join(repoRoot, 'src-server/providers/llm/defaults.ts'),
      'utf8',
    );
    const claude = readFileSync(
      path.join(repoRoot, 'src-server/providers/adapters/claude-adapter.ts'),
      'utf8',
    );
    const codex = readFileSync(
      path.join(repoRoot, 'src-server/providers/adapters/codex-adapter.ts'),
      'utf8',
    );
    for (const command of ['kiro-cli', 'cursor-agent', 'opencode']) {
      expect(defaults).toContain(`command: '${command}'`);
    }
    expect(claude).toContain("command: 'claude'");
    expect(codex).toContain("command: 'codex'");
  });

  it(
    'captures one sentinel-delimited PATH despite shell chatter',
    async () => {
      const root = fixtureRoot();
      const shell = executable(root, 'fixture-shell');
      writeFileSync(
        shell,
        '#!/bin/sh\nprintf "startup chatter\\n"\nprintf "__STATION_PATH_BEGIN__%s__STATION_PATH_END__\\n" "/safe path:/usr/bin"\n',
        { mode: 0o700 },
      );
      await expect(
        captureLoginShellPath(shell, {
          timeoutMs: LOGIN_SHELL_PATH_TIMEOUT_MS,
          allowedShells: [shell],
        }),
      ).resolves.toBe('/safe path:/usr/bin');
    },
    PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it.each([
    ['missing', '/not/a/shell', /unavailable/],
    ['unsupported', process.execPath, /unsupported login shell/],
  ])('falls back for a %s login shell', async (_name, shell, expected) => {
    await expect(
      captureLoginShellPath(shell, { timeoutMs: 100 }),
    ).rejects.toThrow(expected);
  });

  it(
    'rejects non-zero, malformed, and timed-out login shells',
    async () => {
      const root = fixtureRoot();
      const failing = executable(root, 'fail');
      writeFileSync(failing, '#!/bin/sh\nexit 12\n', { mode: 0o700 });
      const malformed = executable(root, 'malformed');
      writeFileSync(malformed, '#!/bin/sh\nprintf noise\n', { mode: 0o700 });
      const hanging = executable(root, 'hanging');
      writeFileSync(hanging, '#!/bin/sh\nsleep 2\n', { mode: 0o700 });
      await expect(
        captureLoginShellPath(failing, {
          timeoutMs: LOGIN_SHELL_PATH_TIMEOUT_MS,
          allowedShells: [failing],
        }),
      ).rejects.toThrow(/status 12/);
      await expect(
        captureLoginShellPath(malformed, {
          timeoutMs: LOGIN_SHELL_PATH_TIMEOUT_MS,
          allowedShells: [malformed],
        }),
      ).rejects.toThrow(/sentinel/);
      await expect(
        captureLoginShellPath(hanging, {
          timeoutMs: 20,
          allowedShells: [hanging],
        }),
      ).rejects.toThrow(/timed out/);
    },
    PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it('bounds and kills a login-shell process group with background descendants holding stdio', async () => {
    const root = fixtureRoot();
    const shell = executable(root, 'descendant-shell');
    writeFileSync(shell, '#!/bin/sh\nsleep 5 &\nwait\n', { mode: 0o700 });
    const started = performance.now();
    await expect(
      captureLoginShellPath(shell, {
        timeoutMs: 40,
        allowedShells: [shell],
      }),
    ).rejects.toThrow(/timed out/);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('atomically publishes a private allowlisted shim set and removes stale clients', () => {
    const root = fixtureRoot();
    const support = path.join(root, 'support');
    mkdirSync(support, { mode: 0o700 });
    const targetDir = path.join(root, 'targets with spaces');
    const codex = executable(targetDir, 'codex', 'codex-target');
    const claude = executable(targetDir, 'claude', 'claude-target');
    const shim = path.join(support, 'bin', 'clients');

    materializeClientShims(shim, { codex, claude });
    expect(statSync(shim).mode & 0o777).toBe(0o700);
    expect(realpathSync(path.join(shim, 'codex'))).toBe(realpathSync(codex));
    expect(execFileSync(path.join(shim, 'claude'), { encoding: 'utf8' })).toBe(
      'claude-target',
    );
    expect(existsSync(path.join(shim, 'unrelated'))).toBe(false);

    materializeClientShims(shim, { codex });
    expect(existsSync(path.join(shim, 'claude'))).toBe(false);
    expect(readFileSync(path.join(shim, 'codex'), 'utf8')).toBe(
      readFileSync(codex, 'utf8'),
    );
  });

  it('leaves the previous shim set intact when a refresh cannot be staged', () => {
    const root = fixtureRoot();
    const support = path.join(root, 'support');
    mkdirSync(support, { mode: 0o700 });
    const targetDir = path.join(root, 'targets');
    const codex = executable(targetDir, 'codex', 'old');
    const shim = path.join(support, 'bin', 'clients');
    materializeClientShims(shim, { codex });

    expect(() =>
      materializeClientShims(shim, { codex: path.join(root, 'missing') }),
    ).toThrow();
    expect(realpathSync(path.join(shim, 'codex'))).toBe(realpathSync(codex));
    expect(execFileSync(path.join(shim, 'codex'), { encoding: 'utf8' })).toBe(
      'old',
    );
  });

  it('rejects a symlinked Station shim parent', () => {
    const root = fixtureRoot();
    const support = path.join(root, 'support');
    const redirected = path.join(root, 'redirected');
    mkdirSync(support, { mode: 0o700 });
    mkdirSync(redirected, { mode: 0o700 });
    const target = executable(path.join(root, 'targets'), 'codex');
    const bin = path.join(support, 'bin');
    symlinkSync(redirected, bin);
    expect(() =>
      materializeClientShims(path.join(bin, 'clients'), { codex: target }),
    ).toThrow(/not a symlink/);
  });

  it('rejects a real client directory outside the expected private root', () => {
    const root = fixtureRoot();
    const expected = path.join(root, 'support', 'bin');
    const outside = path.join(root, 'outside');
    mkdirSync(expected, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const target = executable(path.join(root, 'targets'), 'codex');
    expect(() =>
      materializeClientShims(
        path.join(outside, 'clients'),
        { codex: target },
        { expectedParent: expected },
      ),
    ).toThrow(/expected Station-owned root/);
  });

  it('restores prior plist bytes, shim targets, entries, and modes after a post-mutation failure', () => {
    const root = fixtureRoot();
    const supportBin = path.join(root, 'support', 'bin');
    mkdirSync(supportBin, { recursive: true, mode: 0o700 });
    const targets = path.join(root, 'targets');
    const oldCodex = executable(targets, 'old-codex', 'old');
    const oldClaude = executable(targets, 'old-claude', 'old-claude');
    const newCodex = executable(targets, 'new-codex', 'new');
    const shim = path.join(supportBin, 'clients');
    const plist = path.join(root, 'agent.plist');
    const plistSnapshot = path.join(root, 'agent.plist.snapshot');
    const shimSnapshot = path.join(root, 'clients.snapshot');
    const oldPlist = '<key>PATH</key><string>/old/clients:/usr/bin</string>\n';
    writeFileSync(plist, oldPlist, { mode: 0o600 });
    materializeClientShims(
      shim,
      { codex: oldCodex, claude: oldClaude },
      { expectedParent: supportBin },
    );
    snapshotClientShims(shim, shimSnapshot);
    copyFileSync(plist, plistSnapshot);

    expect(() => {
      materializeClientShims(
        shim,
        { codex: newCodex },
        { expectedParent: supportBin },
      );
      writeFileSync(
        plist,
        '<key>PATH</key><string>/new/clients:/usr/bin</string>\n',
        { mode: 0o644 },
      );
      throw new Error('injected after shim and plist mutation');
    }).toThrow(/injected/);

    restoreClientShims(shimSnapshot, shim);
    copyFileSync(plistSnapshot, plist);
    chmodSync(plist, statSync(plistSnapshot).mode & 0o777);
    expect(readFileSync(plist, 'utf8')).toBe(oldPlist);
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(statSync(shim).mode & 0o777).toBe(0o700);
    expect(realpathSync(path.join(shim, 'codex'))).toBe(realpathSync(oldCodex));
    expect(realpathSync(path.join(shim, 'claude'))).toBe(
      realpathSync(oldClaude),
    );
  });

  it.each(['beforePublish', 'afterPublish'] as const)(
    'keeps the current shim valid when rollback fails at %s',
    (failurePoint) => {
      const root = fixtureRoot();
      const supportBin = path.join(root, 'support', 'bin');
      mkdirSync(supportBin, { recursive: true, mode: 0o700 });
      const targets = path.join(root, 'targets');
      const oldCodex = executable(targets, 'old-codex', 'old');
      const currentCodex = executable(targets, 'current-codex', 'current');
      const shim = path.join(supportBin, 'clients');
      const snapshot = path.join(root, 'snapshot');
      materializeClientShims(
        shim,
        { codex: oldCodex },
        {
          expectedParent: supportBin,
        },
      );
      snapshotClientShims(shim, snapshot);
      materializeClientShims(
        shim,
        { codex: currentCodex },
        {
          expectedParent: supportBin,
        },
      );

      expect(() =>
        restoreClientShims(snapshot, shim, {
          [failurePoint]: () => {
            throw new Error(`injected ${failurePoint}`);
          },
        }),
      ).toThrow(`injected ${failurePoint}`);
      expect(realpathSync(path.join(shim, 'codex'))).toBe(
        realpathSync(currentCodex),
      );
      expect(execFileSync(path.join(shim, 'codex'), { encoding: 'utf8' })).toBe(
        'current',
      );
    },
  );
});
