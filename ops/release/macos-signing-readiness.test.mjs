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
  parseMacosSigningReadinessCli,
  prepareMacosSigningKeychain,
  probeMacosPrivateKey,
  unlockMacosSigningKeychain,
} from './macos-signing-readiness.mjs';

const identity = 'Developer ID Application: Kontour AI LLC (U7KHF2QAC4)';
const fingerprint = 'A'.repeat(40);
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
        stdout: `  1) ${fingerprint} ${JSON.stringify(identities)}\n`,
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
    schemaVersion: 1,
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

test('prepare rejects an expired deadline before reading or mutating a keychain', async () => {
  const calls = [];
  const state = makeStatePath();
  await expect(
    prepareMacosSigningKeychain({
      certificate: '/certificate.p12',
      deadlineEpoch: '2000000010',
      identity,
      keychain: '/keychain',
      now: () => fixedNow,
      password: 'secret',
      run: async (program, args, options) => {
        calls.push({ args, options, program });
        return { status: 0, stderr: '', stdout: '' };
      },
      state,
    }),
  ).rejects.toThrow(/cleanup grace/);
  expect(calls).toEqual([]);
  expect(existsSync(state)).toBe(false);
});

test('requires exactly one exact well-formed identity without exposing hostile output', async () => {
  const hostile = `prefix ${identity} suffix\nsecret-passphrase\n`;
  const candidates = [
    `${identity} extra`,
    `  1) ${fingerprint} ${JSON.stringify(identity)}\n  2) ${'B'.repeat(40)} ${JSON.stringify(identity)}`,
    `  1) ${'C'.repeat(39)} ${JSON.stringify(identity)}`,
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
          stdout: `  1) ${fingerprint} ${JSON.stringify(identity)}\n`,
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
          stdout: `  1) ${fingerprint} ${JSON.stringify(identity)}\n`,
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
      JSON.stringify({
        keychain: '/keychain',
        previous,
        schemaVersion: 1,
        stage: 'search-set',
      }),
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
      schemaVersion: 1,
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

test('rejects malformed security search-list output before keychain mutation', async () => {
  const state = makeStatePath();
  const calls = [];
  await expect(
    prepareMacosSigningKeychain({
      certificate: '/certificate.p12',
      deadlineEpoch,
      identity,
      keychain: '/keychain',
      now: () => fixedNow,
      password: 'secret',
      run: async (program, args, options) => {
        calls.push({ args, options, program });
        return { status: 0, stderr: '', stdout: '"unterminated' };
      },
      state,
    }),
  ).rejects.toThrow(/malformed/);
  expect(securityCommands(calls)).toEqual(['list-keychains']);
  expect(existsSync(state)).toBe(false);
});

test('rejects stale, mismatched, and hostile journals before any cleanup mutation', async () => {
  const valid = {
    keychain: '/keychain',
    previous: ['/prior'],
    schemaVersion: 1,
    stage: 'search-set',
  };
  const invalidRecords = [
    { ...valid, schemaVersion: 0 },
    { ...valid, keychain: '/other-keychain' },
    { ...valid, previous: ['relative.keychain-db'] },
    { ...valid, previous: ['/prior', '/prior'] },
    { ...valid, previous: ['/prior\u0000evil'] },
    { ...valid, unexpected: true },
    '{malformed json',
  ];
  for (const record of invalidRecords) {
    const state = makeStatePath();
    writeFileSync(
      state,
      typeof record === 'string' ? record : JSON.stringify(record),
    );
    const calls = [];
    await expect(
      cleanupMacosSigningKeychain({
        keychain: '/keychain',
        state,
        run: async (program, args, options) => {
          calls.push({ args, options, program });
          return { status: 0, stderr: '', stdout: '' };
        },
      }),
    ).rejects.toThrow('macOS signing keychain cleanup failed.');
    expect(calls).toEqual([]);
    expect(existsSync(state)).toBe(true);
  }
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

test('cleans a partially copied probe when copying throws without exposing copy details', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-private-key-probe-'));
  const probe = join(directory, 'partial-probe');
  const error = await probeMacosPrivateKey({
    copy: () => {
      writeFileSync(probe, 'partial');
      throw new Error('private copy detail');
    },
    identity,
    probe,
    source: process.execPath,
  }).catch((caught) => caught);
  expect(error.message).toBe(
    'macOS private-key readiness probe failed before timestamp signing.',
  );
  expect(error.message).not.toContain('private copy detail');
  expect(existsSync(probe)).toBe(false);
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

test('CLI requires exact mode-specific arguments and only asks each mode for the environment it needs', () => {
  const environment = {
    APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD: 'password',
    APPLE_DEVELOPER_ID_SIGNING_IDENTITY: identity,
  };
  const valid = {
    cleanup: ['--keychain', '/keychain', '--state', '/state'],
    prepare: [
      '--certificate',
      '/certificate',
      '--deadline-epoch',
      deadlineEpoch,
      '--keychain',
      '/keychain',
      '--state',
      '/state',
    ],
    probe: ['--keychain', '/keychain', '--probe', '/probe'],
    unlock: ['--deadline-epoch', deadlineEpoch, '--keychain', '/keychain'],
  };
  for (const [mode, raw] of Object.entries(valid)) {
    expect(
      parseMacosSigningReadinessCli({ env: environment, mode, raw }),
    ).toMatchObject({ mode });
    for (let index = 0; index < raw.length; index += 2) {
      const omitted = [...raw.slice(0, index), ...raw.slice(index + 2)];
      expect(() =>
        parseMacosSigningReadinessCli({ env: environment, mode, raw: omitted }),
      ).toThrow(/exact mode-specific/);
    }
    expect(() =>
      parseMacosSigningReadinessCli({
        env: environment,
        mode,
        raw: [...raw, '--extra', 'value'],
      }),
    ).toThrow(/exact mode-specific/);
    expect(() =>
      parseMacosSigningReadinessCli({
        env: environment,
        mode,
        raw: [...raw, raw[0], raw[1]],
      }),
    ).toThrow(/exact mode-specific/);
  }
  expect(() =>
    parseMacosSigningReadinessCli({
      env: environment,
      mode: 'unknown',
      raw: [],
    }),
  ).toThrow(/exact mode-specific/);
  expect(() =>
    parseMacosSigningReadinessCli({
      env: {},
      mode: 'prepare',
      raw: valid.prepare,
    }),
  ).toThrow(/environment/);
  expect(() =>
    parseMacosSigningReadinessCli({
      env: environment,
      mode: 'prepare',
      raw: valid.prepare.map((value, index) =>
        index === 3 ? 'not-an-epoch' : value,
      ),
    }),
  ).toThrow(/exact mode-specific/);
  expect(() =>
    parseMacosSigningReadinessCli({
      env: { APPLE_DEVELOPER_ID_SIGNING_IDENTITY: identity },
      mode: 'unlock',
      raw: valid.unlock,
    }),
  ).toThrow(/environment/);
  expect(
    parseMacosSigningReadinessCli({
      env: { APPLE_DEVELOPER_ID_SIGNING_IDENTITY: identity },
      mode: 'probe',
      raw: valid.probe,
    }),
  ).toMatchObject({ mode: 'probe' });
  expect(
    parseMacosSigningReadinessCli({
      env: {},
      mode: 'cleanup',
      raw: valid.cleanup,
    }),
  ).toMatchObject({ mode: 'cleanup' });
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
    if (jobName === 'nightly-desktop') {
      const manifest = indexOfStep('Assemble the signed updater manifest');
      const publish = indexOfStep(
        'Publish the rolling desktop nightly prerelease',
      );
      expect(cleanup).toBeLessThan(manifest);
      expect(manifest).toBeLessThan(publish);
    } else {
      const attestation = job.steps.findIndex(
        (step) =>
          step.uses ===
          'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
      );
      expect(cleanup).toBeLessThan(attestation);
    }
  }
  const release = load(readFileSync('.github/workflows/release.yml', 'utf8'));
  const helperJobs = Object.entries(release.jobs)
    .filter(([, job]) =>
      JSON.stringify(job).includes('macos-signing-readiness.mjs'),
    )
    .map(([name]) => name);
  expect(helperJobs).toEqual(['desktop-macos']);
});
