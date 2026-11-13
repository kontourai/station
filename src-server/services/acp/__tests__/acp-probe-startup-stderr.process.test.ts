import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { ENGINE_SIGN_IN_REQUIRED_CODE } from '@kontourai/station-contracts/provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { ACPProbe } from '../acp-probe.js';
import {
  engineSignInStatus,
  resetEngineAuthStatus,
  setEngineStatusTestHooks,
} from '../engine-auth-status.js';

/**
 * An engine that refuses to start says why only on stderr. Kiro CLI signed
 * out prints exactly the line below and exits 1 before answering
 * `initialize` (kiro-cli 2.35.0, `kiro-cli acp`). Through the real spawn:
 * the probe's reason quotes that line instead of a bare "closed the
 * connection", the built-in descriptor's signed-out text records it as a
 * sign-in refusal, and a chat start fails with the typed sign-in code.
 */
const makeTempDir = trackTempDirs();
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const KIRO_SIGNED_OUT =
  'Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.';

/** A launcher named `program` that writes `stderrText` and exits. */
function stubEngine(program: string, stderrText: string, exitCode = 1) {
  const dir = makeTempDir('station-probe-stderr-');
  const script = join(dir, 'refuse.mjs');
  writeFileSync(
    script,
    `process.stderr.write(${JSON.stringify(stderrText)});\nprocess.exit(${exitCode});\n`,
  );
  const launcher = join(dir, program);
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

function connectionFor(command: string): ACPConnectionConfig {
  return {
    id: 'kiro',
    name: 'Kiro CLI',
    command,
    args: ['acp'],
    enabled: true,
  };
}

async function probeOnce(config: ACPConnectionConfig) {
  const probe = new ACPProbe(
    config,
    silentLogger,
    makeTempDir('station-probe-stderr-home-'),
    undefined,
    5_000,
  );
  try {
    await expect(probe.probe('request')).resolves.toBe(false);
    return probe.lastError;
  } finally {
    await probe.dispose();
  }
}

beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
  // Only what the engine said during the launch is evidence here: the
  // status command is made unavailable so it cannot answer instead.
  setEngineStatusTestHooks({ runner: async () => null });
});
afterEach(() => {
  clearAll();
  resetEngineAuthStatus();
  setEngineStatusTestHooks({});
});

describe('an engine that stops during startup', () => {
  test('the probe quotes a signed-out Kiro CLI and records the refusal', async () => {
    const config = connectionFor(
      stubEngine('kiro-cli', `${KIRO_SIGNED_OUT}\n`),
    );
    expect(await probeOnce(config)).toEqual({
      message: `Kiro CLI stopped before it finished starting. It said: ${KIRO_SIGNED_OUT}`,
      phase: 'initialize',
    });
    expect(await engineSignInStatus(config)).toMatchObject({
      state: 'unauthenticated',
      source: 'refusal',
    });
  });

  test('only the last non-empty line is quoted, without terminal styling', async () => {
    const config = connectionFor(
      stubEngine(
        'kiro-cli',
        'starting up\n\u001b[31merror:\u001b[0m You are not logged in, please log in with kiro-cli login\n\n',
      ),
    );
    expect((await probeOnce(config))?.message).toBe(
      'Kiro CLI stopped before it finished starting. It said: error: You are not logged in, please log in with kiro-cli login',
    );
  });

  test('an engine with no declared signed-out text is quoted but not read as signed out', async () => {
    const config = connectionFor(
      stubEngine('some-engine', 'Not logged in to anything\n'),
    );
    expect((await probeOnce(config))?.message).toBe(
      'Kiro CLI stopped before it finished starting. It said: Not logged in to anything',
    );
    expect((await engineSignInStatus(config)).state).toBe('unknown');
  });

  test('an engine that exits silently keeps the plain closed-connection reason', async () => {
    const config = connectionFor(stubEngine('kiro-cli', ''));
    expect((await probeOnce(config))?.message).toBe(
      'Kiro CLI closed the connection before it finished starting.',
    );
    expect((await engineSignInStatus(config)).state).toBe('unknown');
  });

  test('a chat start with a signed-out Kiro CLI fails with the sign-in code', async () => {
    const config = connectionFor(
      stubEngine('kiro-cli', `${KIRO_SIGNED_OUT}\n`),
    );
    const adapter = new AcpAdapter({
      getConnections: async () => [config],
      logger: silentLogger,
    });
    try {
      const failure = await adapter
        .startSession({
          provider: 'acp',
          threadId: 'kiro-signed-out-thread',
          cwd: makeTempDir('station-probe-stderr-cwd-'),
          confinement: 'host',
          metadata: { connectionId: 'kiro' },
        } as never)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toMatchObject({
        code: ENGINE_SIGN_IN_REQUIRED_CODE,
        message: `Kiro CLI needs you to sign in before it can start a chat. ${KIRO_SIGNED_OUT}`,
      });
      expect(await engineSignInStatus(config)).toMatchObject({
        state: 'unauthenticated',
        source: 'refusal',
      });
    } finally {
      await adapter.stopAll();
    }
  });

  test('a chat start with any other engine that stops quotes its last words', async () => {
    const config = connectionFor(
      stubEngine('some-engine', 'fatal: config file is invalid\n'),
    );
    const adapter = new AcpAdapter({
      getConnections: async () => [config],
      logger: silentLogger,
    });
    try {
      const failure = await adapter
        .startSession({
          provider: 'acp',
          threadId: 'other-engine-thread',
          cwd: makeTempDir('station-probe-stderr-cwd-'),
          confinement: 'host',
          metadata: { connectionId: 'kiro' },
        } as never)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect((failure as Error).message).toBe(
        'Kiro CLI stopped before it finished starting. It said: fatal: config file is invalid',
      );
      expect((failure as { code?: unknown }).code).toBeUndefined();
    } finally {
      await adapter.stopAll();
    }
  });
});
