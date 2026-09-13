import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CliCommandResult } from '../../../providers/auth/cli-auth.js';
import {
  ENGINE_LOGIN_CAPABILITY_TTL_MS,
  type EngineLoginCapabilityDeps,
  engineLoginCapabilities,
  loginMechanisms,
  mechanismEvidence,
  resetEngineLoginCapabilityCache,
} from '../engine-login-capabilities.js';
import {
  CLAUDE_LOGIN_HELP_STDOUT,
  CODEX_LOGIN_HELP_STDOUT,
} from './device-code-cli-output.js';

/**
 * Every probe below is fed the help text the real CLI printed on 2026-09-11
 * (see `device-code-cli-output.ts`). Nothing here spawns: the point is that
 * the module's answer is a function of the CLI's OUTPUT, so replaying that
 * output exercises the whole derivation.
 */
function stubDeps(
  responses: Record<string, string>,
  options: {
    binary?: (command: string) => string | null;
    nowMs?: () => number;
  } = {},
): EngineLoginCapabilityDeps & {
  runCommand: ReturnType<typeof vi.fn>;
  findBinary: ReturnType<typeof vi.fn>;
} {
  const runCommand = vi.fn(
    async (
      command: string,
      args: string[],
    ): Promise<CliCommandResult | null> => {
      const key = [command, ...args].join(' ');
      const stdout = responses[key];
      if (stdout === undefined) return null;
      return { stdout, stderr: '', code: 0 };
    },
  );
  const findBinary = vi.fn(async (command: string) =>
    options.binary ? options.binary(command) : command,
  );
  const nowMs = options.nowMs ?? (() => 1_700_000_000_000);
  return {
    runCommand: runCommand as never,
    findBinary: findBinary as never,
    now: () => new Date(nowMs()),
  } as never;
}

beforeEach(() => {
  resetEngineLoginCapabilityCache();
});

describe('a login mechanism is observed, never declared', () => {
  test('codex declares device-code because codex itself prints the flag', async () => {
    const deps = stubDeps({
      'codex login --help': CODEX_LOGIN_HELP_STDOUT,
    });
    const capabilities = await engineLoginCapabilities('codex', deps);

    expect(loginMechanisms(capabilities).sort()).toEqual([
      'api-key-stdin',
      'device-code',
    ]);
    const evidence = mechanismEvidence(capabilities, 'device-code');
    expect(evidence?.observedMatch).toBe('--device-auth');
    expect(evidence?.observedCommand).toEqual(['codex', 'login', '--help']);
    expect(capabilities.unavailableReason).toBeUndefined();
  });

  test('claude declares no device-code, because its login help names none', async () => {
    const deps = stubDeps({
      'claude auth login --help': CLAUDE_LOGIN_HELP_STDOUT,
    });
    const capabilities = await engineLoginCapabilities('claude', deps);

    expect(loginMechanisms(capabilities)).toEqual([]);
    expect(mechanismEvidence(capabilities, 'device-code')).toBeUndefined();
    // Absent is not the same fact as unaskable. The CLI answered.
    expect(capabilities.unavailableReason).toBeUndefined();
  });

  test('the argument passed is the flag that was matched, so a rename is followed', async () => {
    // Same CLI, one word different. Nothing in this module transcribes
    // `--device-auth`, so the renamed spelling becomes the argument.
    const deps = stubDeps({
      'codex login --help': CODEX_LOGIN_HELP_STDOUT.replace(
        '--device-auth',
        '--device-code',
      ),
    });
    const capabilities = await engineLoginCapabilities('codex', deps);

    expect(mechanismEvidence(capabilities, 'device-code')?.argument).toBe(
      '--device-code',
    );
  });

  test('a flag Station has never seen is not read as a device-code login', async () => {
    const deps = stubDeps({
      'codex login --help': CODEX_LOGIN_HELP_STDOUT.replace(
        '--device-auth',
        '--browser-auth',
      ),
    });
    const capabilities = await engineLoginCapabilities('codex', deps);

    expect(loginMechanisms(capabilities)).toEqual(['api-key-stdin']);
  });
});

describe('a CLI that cannot be asked is unavailable, not unsupported', () => {
  test('an absent binary reports why, and nothing is executed', async () => {
    const deps = stubDeps({}, { binary: () => null });
    const capabilities = await engineLoginCapabilities('codex', deps);

    expect(capabilities.unavailableReason).toMatch(
      /was not found on this host/,
    );
    expect(capabilities.evidence).toEqual([]);
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  test('a probe that produced no result reports why, rather than reporting absence', async () => {
    const deps = stubDeps({});
    const capabilities = await engineLoginCapabilities('codex', deps);

    expect(capabilities.unavailableReason).toMatch(/could not be asked/);
    expect(loginMechanisms(capabilities)).toEqual([]);
  });
});

describe('probing is bounded work', () => {
  test('concurrent callers share one probe', async () => {
    const deps = stubDeps({ 'codex login --help': CODEX_LOGIN_HELP_STDOUT });
    const [first, second] = await Promise.all([
      engineLoginCapabilities('codex', deps),
      engineLoginCapabilities('codex', deps),
    ]);

    expect(deps.runCommand).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  test('the cache expires, so a CLI upgrade is observed without a restart', async () => {
    let nowMs = 1_700_000_000_000;
    const deps = stubDeps(
      { 'codex login --help': CODEX_LOGIN_HELP_STDOUT },
      { nowMs: () => nowMs },
    );

    await engineLoginCapabilities('codex', deps);
    nowMs += ENGINE_LOGIN_CAPABILITY_TTL_MS - 1;
    await engineLoginCapabilities('codex', deps);
    expect(deps.runCommand).toHaveBeenCalledTimes(1);

    nowMs += 2;
    await engineLoginCapabilities('codex', deps);
    expect(deps.runCommand).toHaveBeenCalledTimes(2);
  });
});
