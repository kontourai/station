// @vitest-environment node

/**
 * station#1586 (item 6): the first `startSession` in a process used to pay
 * for the Claude executable resolution and its `claude --version` probe,
 * because nothing at boot had ever reached them — readiness is resolved
 * lazily by the `/status` route. These drive the real `ClaudeAdapter` (its
 * CLI seams injected, so no host `claude` decides anything) rather than a
 * stub, because the whole claim is about the adapter's own memo: one probe
 * for the boot prime, and none left for the session that follows.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import { primeEnginePrerequisites } from '../engine-prerequisite-priming.js';

const CLAUDE = '/usr/local/bin/claude';

function claudeAdapterWithProbe() {
  const runCommand = vi.fn(async (_command: string, _args: string[]) => ({
    code: 0,
    stdout: '1.2.3 (Claude Code)',
    stderr: '',
  }));
  const adapter = new ClaudeAdapter({
    findBinary: async () => CLAUDE,
    runCommand,
    executablePlatform: 'linux',
    executableFileExists: () => true,
    readBundledVersion: () => '1.0.0',
  });
  const versionProbes = () =>
    runCommand.mock.calls.filter((call) => call[1]?.[0] === '--version');
  return { adapter, runCommand, versionProbes };
}

describe('primeEnginePrerequisites (station#1586 item 6)', () => {
  beforeEach(() => {
    // The auth leaf reads a config directory rather than spawning; point it
    // at one that cannot exist so this suite reads nothing of the host's and
    // answers the same way on every machine.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/nonexistent/station-1586-priming');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('runs the Claude version probe once, and leaves nothing for the first session to pay', async () => {
    const { adapter, versionProbes } = claudeAdapterWithProbe();

    await primeEnginePrerequisites({ adapters: [adapter] });

    expect(versionProbes()).toHaveLength(1);
    expect(versionProbes()[0][0]).toBe(CLAUDE);

    // What a session start would do next. The adapter memoizes one completed,
    // zero-exit probe per `command + args`, so priming is a head start rather
    // than an extra spawn — that dedupe is the whole reason this is safe to
    // fire at boot.
    await adapter.getPrerequisites();
    expect(versionProbes()).toHaveLength(1);
  });

  test('a probe that fails is reported, not thrown — boot never fails on it', async () => {
    const warn = vi.fn();
    const failing = {
      provider: 'claude',
      getPrerequisites: vi.fn().mockRejectedValue(new Error('probe exploded')),
    };

    await expect(
      primeEnginePrerequisites({ adapters: [failing], logger: { warn } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('probe exploded'),
    );
  });

  test('an adapter that cannot report prerequisites is skipped, not assumed ready', async () => {
    const warn = vi.fn();
    await expect(
      primeEnginePrerequisites({
        adapters: [{ provider: 'plugin-engine' }],
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  test('an already-aborted signal primes nothing', async () => {
    const adapter = {
      provider: 'claude',
      getPrerequisites: vi.fn().mockResolvedValue([]),
    };
    const controller = new AbortController();
    controller.abort();

    await primeEnginePrerequisites({
      adapters: [adapter],
      signal: controller.signal,
    });

    expect(adapter.getPrerequisites).not.toHaveBeenCalled();
  });
});
