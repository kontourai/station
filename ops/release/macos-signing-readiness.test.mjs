import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { expect, test, vi } from 'vitest';
import { runBoundedCommand } from './macos-notarized-artifacts.mjs';
import {
  cleanupMacosSigningKeychain,
  KEYCHAIN_UNLOCK_LIFETIME_SECONDS,
  lifetimeFromDeadline,
  PRIVATE_KEY_PROBE_TIMEOUT_MS,
  prepareMacosSigningKeychain,
  probeMacosPrivateKey,
  unlockMacosSigningKeychain,
} from './macos-signing-readiness.mjs';

const identity = 'Developer ID Application: Kontour AI (ABCD1234)';
const fixedNow = 2_000_000_000_000;
const deadlineEpoch = '2000000100';

function makeStatePath() {
  return join(
    mkdtempSync(join(tmpdir(), 'station-keychain-state-')),
    'state.json',
  );
}

function stateAt(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function successRun(
  calls,
  { previous = ['/prior.keychain-db'], identities = identity } = {},
) {
  return async (program, args, options) => {
    calls.push({ args, options, program });
    if (args[0] === 'list-keychains' && !args.includes('-s')) {
      return {
        status: 0,
        stdout: previous.map((item) => `"${item}"`).join('\n'),
        stderr: '',
      };
    }
    if (args[0] === 'find-identity') {
      return {
        status: 0,
        stdout: `  1) 0123456789 ${JSON.stringify(identities)}\n`,
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function securityCommands(calls) {
  return calls.map(({ args }) => args[0]);
}

test('prepare journals every recovery stage and orders all bounded keychain commands', async () => {
  const state = makeStatePath();
  const calls = [];
  const observedStages = [];
  const run = successRun(calls);
  const recordingRun = async (...args) => {
    observedStages.push(existsSync(state) ? stateAt(state).stage : null);
    return run(...args);
  };

  await prepareMacosSigningKeychain({
    certificate: '/certificate.p12',
    deadlineEpoch,
    identity,
    keychain: '/temporary.keychain-db',
    now: () => fixedNow,
    password: 'never-log-this',
    run: recordingRun,
    state,
  });

  expect(securityCommands(calls)).toEqual([
    'list-keychains',
    'create-keychain',
    'set-keychain-settings',
    'unlock-keychain',
    'import',
    'set-key-partition-list',
    'find-identity',
    'list-keychains',
  ]);
  expect(observedStages).toEqual([
    null,
    'captured',
    'created',
    'created',
    'created',
    'created',
    'created',
    'search-restore-required',
  ]);
  expect(
    calls.every(
      ({ options }) => options.timeoutMs === PRIVATE_KEY_PROBE_TIMEOUT_MS,
    ),
  ).toBe(true);
  expect(calls[2].args).toEqual([
    'set-keychain-settings',
    '-lut',
    '90',
    '/temporary.keychain-db',
  ]);
  expect(stateAt(state)).toEqual({
    keychain: '/temporary.keychain-db',
    previous: ['/prior.keychain-db'],
    stage: 'search-set',
  });
});

test('re-unlock sets a strictly fresher, smaller lifetime immediately before unlock', async () => {
  const state = makeStatePath();
  const calls = [];
  const run = successRun(calls);
  await prepareMacosSigningKeychain({
    certificate: '/certificate.p12',
    deadlineEpoch,
    identity,
    keychain: '/keychain',
    now: () => fixedNow,
    password: 'secret',
    run,
    state,
  });
  await unlockMacosSigningKeychain({
    deadlineEpoch,
    identity,
    keychain: '/keychain',
    now: () => fixedNow + 10_000,
    password: 'secret',
    run,
  });

  const settings = calls.filter(
    ({ args }) => args[0] === 'set-keychain-settings',
  );
  expect(settings.map(({ args }) => Number(args[2]))).toEqual([90, 80]);
  const refreshIndex = calls.findIndex(
    ({ args }) => args[0] === 'set-keychain-settings' && args[2] === '80',
  );
  expect(calls[refreshIndex + 1].args).toEqual([
    'unlock-keychain',
    '-p',
    'secret',
    '/keychain',
  ]);
});

test('rejects malformed, past, and insufficient signing deadlines before mutation', () => {
  expect(() => lifetimeFromDeadline('not-an-epoch', () => fixedNow)).toThrow(
    /valid/,
  );
  expect(() => lifetimeFromDeadline('1999999999', () => fixedNow)).toThrow(
    /cleanup grace/,
  );
  expect(() => lifetimeFromDeadline('2000000010', () => fixedNow)).toThrow(
    /cleanup grace/,
  );
  expect(lifetimeFromDeadline('2000007000', () => fixedNow)).toBe(
    KEYCHAIN_UNLOCK_LIFETIME_SECONDS,
  );
});

test('requires exactly one exact well-formed identity without exposing hostile output', async () => {
  const hostile = `prefix ${identity} suffix\nsecret-passphrase\n`;
  const candidates = [
    `${identity} extra`,
    `  1) 0123456789 ${JSON.stringify(identity)}\n  2) 9876543210 ${JSON.stringify(identity)}`,
    hostile,
    '  1) malformed identity output',
  ];
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (const output of candidates) {
      const state = makeStatePath();
      const calls = [];
      const run = async (program, args, options) => {
        calls.push({ args, options, program });
        if (args[0] === 'list-keychains' && !args.includes('-s'))
          return { status: 0, stdout: '"/prior"', stderr: '' };
        if (args[0] === 'find-identity')
          return { status: 0, stdout: output, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      await expect(
        prepareMacosSigningKeychain({
          certificate: '/certificate.p12',
          deadlineEpoch,
          identity,
          keychain: '/keychain',
          now: () => fixedNow,
          password: 'secret',
          run,
          state,
        }),
      ).rejects.toThrow(
        'Configured Developer ID signing identity is not uniquely available.',
      );
      expect(stateAt(state).stage).toBe('created');
      expect(calls.at(-1).args[0]).toBe('find-identity');
    }
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
    consoleLog.mockRestore();
  }
});

test('fails safely after create, import, or identity validation while retaining the recovery journal', async () => {
  for (const failedCommand of ['create-keychain', 'import', 'find-identity']) {
    const state = makeStatePath();
    const calls = [];
    const run = async (program, args, options) => {
      calls.push({ args, options, program });
      if (args[0] === failedCommand) throw new Error('private failure detail');
      if (args[0] === 'list-keychains' && !args.includes('-s'))
        return { status: 0, stdout: '"/prior"', stderr: '' };
      if (args[0] === 'find-identity')
        return {
          status: 0,
          stdout: `  1) ABC ${JSON.stringify(identity)}\n`,
          stderr: '',
        };
      return { status: 0, stdout: '', stderr: '' };
    };
    await expect(
      prepareMacosSigningKeychain({
        certificate: '/certificate.p12',
        deadlineEpoch,
        identity,
        keychain: '/keychain',
        now: () => fixedNow,
        password: 'secret',
        run,
        state,
      }),
    ).rejects.toThrow(/keychain operation failed/);
    expect(stateAt(state).stage).toBe(
      failedCommand === 'create-keychain' ? 'captured' : 'created',
    );
  }
});

test('records search restoration before a failed or interrupted search-list mutation', async () => {
  for (const failure of ['reported failure', 'interruption']) {
    const state = makeStatePath();
    let searchWasMutated = false;
    const calls = [];
    const run = async (program, args, options) => {
      calls.push({ args, options, program });
      if (args[0] === 'list-keychains' && args.includes('-s')) {
        searchWasMutated = true;
        throw new Error(failure);
      }
      if (args[0] === 'list-keychains')
        return { status: 0, stdout: '"/prior"', stderr: '' };
      if (args[0] === 'find-identity')
        return {
          status: 0,
          stdout: `  1) ABC ${JSON.stringify(identity)}\n`,
          stderr: '',
        };
      return { status: 0, stdout: '', stderr: '' };
    };
    await expect(
      prepareMacosSigningKeychain({
        certificate: '/certificate.p12',
        deadlineEpoch,
        identity,
        keychain: '/keychain',
        now: () => fixedNow,
        password: 'secret',
        run,
        state,
      }),
    ).rejects.toThrow(/keychain operation failed/);
    expect(searchWasMutated).toBe(true);
    expect(stateAt(state).stage).toBe('search-restore-required');
  }
});

test('keeps search restoration recoverable when post-mutation state persistence fails', async () => {
  const state = makeStatePath();
  const stages = [];
  const calls = [];
  const writeState = (record) => {
    stages.push(record.stage);
    if (record.stage === 'search-set') throw new Error('disk interruption');
    writeFileSync(record.state, JSON.stringify(record), { mode: 0o600 });
  };
  await expect(
    prepareMacosSigningKeychain({
      certificate: '/certificate.p12',
      deadlineEpoch,
      identity,
      keychain: '/keychain',
      now: () => fixedNow,
      password: 'secret',
      run: successRun(calls),
      state,
      writeState,
    }),
  ).rejects.toThrow('disk interruption');
  expect(stages).toEqual([
    'captured',
    'created',
    'search-restore-required',
    'search-set',
  ]);
  expect(stateAt(state).stage).toBe('search-restore-required');
  expect(calls.at(-1).args).toEqual([
    'list-keychains',
    '-d',
    'user',
    '-s',
    '/keychain',
  ]);
});

test('cleanup restores empty and nonempty prior search lists and removes a fully cleaned journal', async () => {
  for (const previous of [[], ['/one.keychain-db', '/two.keychain-db']]) {
    const state = makeStatePath();
    writeFileSync(
      state,
      JSON.stringify({ keychain: '/keychain', previous, stage: 'search-set' }),
    );
    const calls = [];
    await cleanupMacosSigningKeychain({
      keychain: '/keychain',
      state,
      run: successRun(calls),
    });
    expect(calls[0].args).toEqual([
      'list-keychains',
      '-d',
      'user',
      '-s',
      ...previous,
    ]);
    expect(securityCommands(calls)).toEqual([
      'list-keychains',
      'lock-keychain',
      'delete-keychain',
    ]);
    expect(existsSync(state)).toBe(false);
  }
});

test('cleanup attempts restore, lock, and delete after every failure and retains the journal', async () => {
  const state = makeStatePath();
  writeFileSync(
    state,
    JSON.stringify({
      keychain: '/keychain',
      previous: ['/prior'],
      stage: 'search-set',
    }),
  );
  const calls = [];
  await expect(
    cleanupMacosSigningKeychain({
      keychain: '/keychain',
      state,
      run: async (program, args, options) => {
        calls.push({ args, options, program });
        throw new Error('do not reveal this secret');
      },
    }),
  ).rejects.toThrow('macOS signing keychain cleanup failed.');
  expect(securityCommands(calls)).toEqual([
    'list-keychains',
    'lock-keychain',
    'delete-keychain',
  ]);
  expect(existsSync(state)).toBe(true);
  expect(stateAt(state).stage).toBe('search-set');
});

test('cleanup is safe without a journal even if best-effort keychain removal fails', async () => {
  const state = join(
    mkdtempSync(join(tmpdir(), 'station-missing-state-')),
    'missing.json',
  );
  const calls = [];
  await expect(
    cleanupMacosSigningKeychain({
      keychain: '/keychain',
      state,
      run: async (program, args, options) => {
        calls.push({ args, options, program });
        throw new Error('gone already');
      },
    }),
  ).resolves.toBeUndefined();
  expect(securityCommands(calls)).toEqual(['lock-keychain', 'delete-keychain']);
});

test('normalizes security nonzero and timeout faults without retrying or leaking inputs', async () => {
  for (const result of [
    { status: 1, stdout: 'sensitive', stderr: 'sensitive' },
    Promise.reject(new Error('sensitive timeout')),
  ]) {
    const calls = [];
    const run = async (program, args, options) => {
      calls.push({ args, options, program });
      return result;
    };
    const error = await prepareMacosSigningKeychain({
      certificate: '/certificate.p12',
      deadlineEpoch,
      identity,
      keychain: '/keychain',
      now: () => fixedNow,
      password: 'sensitive',
      run,
      state: makeStatePath(),
    }).catch((caught) => caught);
    expect(error.message).toBe('macOS signing keychain operation failed.');
    expect(error.message).not.toContain('sensitive');
    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeoutMs).toBe(PRIVATE_KEY_PROBE_TIMEOUT_MS);
  }
});

test('runs one timestamp-free private-key probe, bounds every outcome, and removes scratch files', async () => {
  for (const outcome of [
    { status: 0, stdout: '', stderr: '' },
    { status: 1, stdout: 'private secret', stderr: 'private secret' },
    Promise.reject(new Error('private timeout secret')),
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'station-private-key-probe-'));
    const probe = join(directory, 'probe');
    const calls = [];
    const run = async (program, args, options) => {
      calls.push({ args, options, program });
      return outcome;
    };
    const assertion = probeMacosPrivateKey({
      identity,
      probe,
      run,
      source: process.execPath,
    });
    if (outcome.status === 0) await expect(assertion).resolves.toBeUndefined();
    else {
      const error = await assertion.catch((caught) => caught);
      expect(error.message).toBe(
        'macOS private-key readiness probe failed before timestamp signing.',
      );
      expect(error.message).not.toContain('secret');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--timestamp=none');
    expect(calls[0].options.timeoutMs).toBe(PRIVATE_KEY_PROBE_TIMEOUT_MS);
    expect(existsSync(probe)).toBe(false);
  }
});

test('bounds a hung private-key probe through the owned process group and removes it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-private-key-probe-'));
  const probe = join(directory, 'probe');
  const logs = [];
  await expect(
    probeMacosPrivateKey({
      identity,
      probe,
      source: process.execPath,
      run: (_program, _args, options) =>
        runBoundedCommand(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
          ],
          {
            ...options,
            logger: {
              error: (line) => logs.push(line),
              log: (line) => logs.push(line),
            },
            terminationGraceMs: 20,
            timeoutMs: 50,
          },
        ),
    }),
  ).rejects.toThrow(
    'macOS private-key readiness probe failed before timestamp signing.',
  );
  expect(logs.join('\n')).toContain('macOS private-key readiness probe');
  expect(existsSync(probe)).toBe(false);
});

test('CLI accepts only known unique non-secret arguments and reads secrets only from the environment', () => {
  const script = 'ops/release/macos-signing-readiness.mjs';
  const invoke = (args, env = {}) => {
    try {
      execFileSync(process.execPath, [script, ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: 'pipe',
      });
      return null;
    } catch (error) {
      return String(error.stderr);
    }
  };
  for (const args of [
    ['prepare', '--unknown', 'value'],
    ['prepare', '--keychain', '/one', '--keychain', '/two'],
    ['prepare', '--keychain', '/one', '--password', 'cli-secret-value'],
    ['prepare', '--keychain', '/one'],
  ]) {
    const stderr = invoke(args);
    expect(stderr).toMatch(/Expected/);
    expect(stderr).not.toContain('cli-secret-value');
  }
  const source = readFileSync(script, 'utf8');
  expect(source).not.toContain('values.password');
  expect(source).toContain(
    'process.env.APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD',
  );
});

test('both macOS release paths retain the required signing-readiness topology and leave iOS untouched', () => {
  for (const [file, jobName, deadline] of [
    [
      '.github/workflows/nightly.yml',
      'nightly-desktop',
      'nightly_macos_release_deadline',
    ],
    [
      '.github/workflows/release.yml',
      'desktop-macos',
      'macos_release_deadline',
    ],
  ]) {
    const workflow = load(readFileSync(file, 'utf8'));
    const job = workflow.jobs[jobName];
    const indexOfStep = (name) =>
      job.steps.findIndex((step) => step.name === name);
    const prepare = indexOfStep('Import macOS Developer ID certificate');
    const build =
      indexOfStep('Build an unsigned macOS nightly staging candidate') >= 0
        ? indexOfStep('Build an unsigned macOS nightly staging candidate')
        : indexOfStep('Build an unsigned macOS staging candidate');
    const seal = job.steps.findIndex((step) =>
      step.name?.startsWith('Seal, notarize'),
    );
    const cleanup = indexOfStep('Cleanup macOS Developer ID keychain');
    expect(job.steps[0]).toMatchObject({ id: deadline });
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(build);
    expect(build).toBeLessThan(seal);
    expect(seal).toBeLessThan(cleanup);
    expect(job.steps[prepare].env).toHaveProperty(
      'APPLE_DEVELOPER_ID_SIGNING_IDENTITY',
    );
    expect(job.steps[prepare].run).toContain(
      `--deadline-epoch "\${{ steps.${deadline}.outputs.epoch }}"`,
    );
    expect(job.steps[seal].env).toHaveProperty(
      'APPLE_DEVELOPER_ID_SIGNING_IDENTITY',
    );
    expect(job.steps[seal].run).toContain('macos-signing-readiness.mjs unlock');
    expect(job.steps[seal].run).toContain('macos-signing-readiness.mjs probe');
    expect(
      job.steps[seal].run.indexOf('macos-signing-readiness.mjs unlock'),
    ).toBeLessThan(
      job.steps[seal].run.indexOf('macos-notarized-artifacts.mjs'),
    );
    expect(job.steps[cleanup]).toMatchObject({ if: 'always()' });
    expect(job.steps[cleanup].run).toContain('helper_status=$?');
    expect(job.steps[cleanup].run).toContain('rm_status=$?');
    expect(job.steps[cleanup].run).toContain(
      'test "$helper_status" -eq 0 && test "$rm_status" -eq 0',
    );
  }
  const iosWorkflow = readFileSync('.github/workflows/build-ios.yml', 'utf8');
  expect(iosWorkflow).not.toContain('macos-signing-readiness.mjs');
  expect(iosWorkflow).not.toContain('APPLE_DEVELOPER_ID_SIGNING_IDENTITY');
});
