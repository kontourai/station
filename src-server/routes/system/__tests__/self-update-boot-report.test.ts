import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { reportSelfUpdateRestartAtBoot } from '../self-update-boot-report.js';
import {
  restartStateFilePath,
  writeSelfUpdateRestartRecord,
} from '../self-update-restart-state.js';

let tmpDirs: string[] = [];
function tmpGitRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-boot-report-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const NOW = Date.parse('2026-08-02T03:30:00.000Z');

describe('reportSelfUpdateRestartAtBoot (station#1903 AC: read the restart state on boot)', () => {
  test('a non-source-checkout install is a no-op — nothing to read', () => {
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/some/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'desktop-bundle',
        stampPath: '/x',
        channel: 'nightly',
        ref: 'origin/main',
        sha: 'a'.repeat(40),
        repository: 'https://github.com/kontourai/station.git',
        createdAt: null,
        sourceCheckout: null,
      }),
      now: () => NOW,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('no restart-state file at all is silent — nothing was ever attempted', () => {
    const gitRoot = tmpGitRoot();
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      }),
      now: () => NOW,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('a verified prior restart is silent — the whole point is not to nag about a healthy update', () => {
    const gitRoot = tmpGitRoot();
    writeSelfUpdateRestartRecord(restartStateFilePath(gitRoot), {
      instanceId: 'default',
      hash: 'abc1234',
      pid: 4242,
      port: 3141,
      startedAt: '2026-08-02T03:20:00.000Z',
      status: 'verified',
      resolvedAt: '2026-08-02T03:20:05.000Z',
    });
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      }),
      now: () => NOW,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('a fresh in-flight pending restart is silent — this boot IS very likely the one being verified', () => {
    const gitRoot = tmpGitRoot();
    writeSelfUpdateRestartRecord(restartStateFilePath(gitRoot), {
      instanceId: 'default',
      hash: 'abc1234',
      pid: 0,
      port: 3141,
      startedAt: new Date(NOW - 5_000).toISOString(),
      status: 'pending',
    });
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      }),
      now: () => NOW,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('a failed restart is surfaced with the hash, pid, and fixed failure code (AC: unresolved/failed never silent)', () => {
    const gitRoot = tmpGitRoot();
    writeSelfUpdateRestartRecord(restartStateFilePath(gitRoot), {
      instanceId: 'default',
      hash: 'abc1234',
      pid: 4242,
      port: 3141,
      startedAt: '2026-08-02T03:20:00.000Z',
      status: 'failed',
      resolvedAt: '2026-08-02T03:21:30.000Z',
      failureCode: 'health-unreachable',
    });
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      }),
      now: () => NOW,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [message] = log.warn.mock.calls[0] as [string];
    expect(message).toContain('abc1234');
    expect(message).toContain('4242');
    expect(message).toContain('health-unreachable');
    expect(message).not.toContain(gitRoot);
  });

  test('a stale pending restart (watchdog itself never resolved it) is surfaced', () => {
    const gitRoot = tmpGitRoot();
    writeSelfUpdateRestartRecord(restartStateFilePath(gitRoot), {
      instanceId: 'default',
      hash: 'abc1234',
      pid: 0,
      port: 3141,
      startedAt: new Date(NOW - 5 * 60_000).toISOString(),
      status: 'pending',
    });
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      }),
      now: () => NOW,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('never resolved');
  });

  test('logs only the bounded persisted failure code, never a path or raw diagnostic text', () => {
    const gitRoot = tmpGitRoot();
    const secrets = [
      'https://user:password@example.test/private',
      '/Users/alice/.station/private-build',
      'token=station-secret-token',
    ];
    writeSelfUpdateRestartRecord(restartStateFilePath(gitRoot), {
      instanceId: 'default',
      hash: 'abc1234',
      pid: 4242,
      port: 3141,
      startedAt: '2026-08-02T03:20:00.000Z',
      status: 'failed',
      resolvedAt: '2026-08-02T03:21:30.000Z',
      failureCode: 'identity-mismatch',
    });
    const log = { warn: vi.fn() };
    reportSelfUpdateRestartAtBoot('/module/dir', log, {
      resolveProvenance: () => ({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      }),
      now: () => NOW,
    });

    const emitted = JSON.stringify(log.warn.mock.calls);
    expect(emitted).toContain('identity-mismatch');
    expect(emitted).not.toContain(gitRoot);
    for (const secret of secrets) expect(emitted).not.toContain(secret);
  });
});
