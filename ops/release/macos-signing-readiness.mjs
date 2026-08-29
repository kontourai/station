import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { runBoundedCommand } from './macos-notarized-artifacts.mjs';

export const KEYCHAIN_UNLOCK_LIFETIME_SECONDS = 105 * 60;
export const PRIVATE_KEY_PROBE_TIMEOUT_MS = 60 * 1000;

export function lifetimeFromDeadline(epoch, now = Date.now) {
  if (typeof epoch !== 'string' || !/^[1-9][0-9]{9,10}$/.test(epoch))
    throw new Error('Expected a valid macOS signing deadline epoch.');
  const remaining = Number(epoch) * 1000 - now() - 10_000;
  if (!Number.isSafeInteger(remaining) || remaining <= 0)
    throw new Error('macOS signing deadline lacks cleanup grace.');
  const lifetime = Math.min(
    KEYCHAIN_UNLOCK_LIFETIME_SECONDS,
    Math.floor(remaining / 1000),
  );
  // `security set-keychain-settings -lut 0` is neither a bounded usable
  // unlock nor a safe cleanup window. Treat that last sub-second interval as
  // exhausted before mutating the keychain.
  if (lifetime < 1)
    throw new Error('macOS signing deadline lacks a usable unlock lifetime.');
  return lifetime;
}

async function security(phase, args, run = runBoundedCommand) {
  try {
    const result = await run('security', args, {
      phase: `macOS signing keychain ${phase}`,
      timeoutMs: PRIVATE_KEY_PROBE_TIMEOUT_MS,
    });
    if (result?.status !== 0) throw new Error('security returned nonzero.');
    return result;
  } catch {
    throw new Error('macOS signing keychain operation failed.');
  }
}

async function previousSearchList(run) {
  return (
    await security('capture search list', ['list-keychains', '-d', 'user'], run)
  ).stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function exactIdentityMatches(output, identity) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\)\s+[^\s]+\s+"([^"]+)"\s*$/)?.[1])
    .filter((candidate) => candidate === identity).length;
}

function persistSigningKeychainState({ state, keychain, previous, stage }) {
  writeFileSync(state, JSON.stringify({ keychain, previous, stage }), {
    mode: 0o600,
  });
}

export async function prepareMacosSigningKeychain({
  certificate,
  identity,
  keychain,
  password,
  state,
  deadlineEpoch,
  now,
  run,
  writeState = persistSigningKeychainState,
}) {
  const previous = await previousSearchList(run);
  writeState({ keychain, previous, state, stage: 'captured' });
  await security('create', ['create-keychain', '-p', password, keychain], run);
  writeState({ keychain, previous, state, stage: 'created' });
  await security(
    'set bounded lifetime',
    [
      'set-keychain-settings',
      '-lut',
      String(lifetimeFromDeadline(deadlineEpoch, now)),
      keychain,
    ],
    run,
  );
  await security('unlock', ['unlock-keychain', '-p', password, keychain], run);
  await security(
    'import',
    [
      'import',
      certificate,
      '-k',
      keychain,
      '-P',
      password,
      '-T',
      '/usr/bin/codesign',
    ],
    run,
  );
  // Retain the existing least-privilege partition set; do not broaden it with
  // an unqualified codesign: entry when a Developer-ID P12 may hold two keys.
  await security(
    'set partition list',
    [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:',
      '-s',
      '-k',
      password,
      keychain,
    ],
    run,
  );
  const matches = exactIdentityMatches(
    (
      await security(
        'validate identity',
        ['find-identity', '-v', '-p', 'codesigning', keychain],
        run,
      )
    ).stdout,
    identity,
  );
  if (matches !== 1)
    throw new Error(
      'Configured Developer ID signing identity is not uniquely available.',
    );
  // Record restoration intent before mutating the process-global search list.
  // If `security` reports an interruption after applying the mutation, cleanup
  // can still restore the captured list.
  writeState({ keychain, previous, state, stage: 'search-restore-required' });
  await security(
    'set search list',
    ['list-keychains', '-d', 'user', '-s', keychain],
    run,
  );
  writeState({ keychain, previous, state, stage: 'search-set' });
}

export async function unlockMacosSigningKeychain({
  identity,
  keychain,
  password,
  deadlineEpoch,
  now,
  run,
}) {
  await security(
    'refresh bounded lifetime',
    [
      'set-keychain-settings',
      '-lut',
      String(lifetimeFromDeadline(deadlineEpoch, now)),
      keychain,
    ],
    run,
  );
  await security(
    're-unlock',
    ['unlock-keychain', '-p', password, keychain],
    run,
  );
  const matches = exactIdentityMatches(
    (
      await security(
        'validate identity',
        ['find-identity', '-v', '-p', 'codesigning', keychain],
        run,
      )
    ).stdout,
    identity,
  );
  if (matches !== 1)
    throw new Error(
      'Configured Developer ID signing identity is not uniquely available.',
    );
}

export async function probeMacosPrivateKey({
  identity,
  probe,
  source = '/usr/bin/true',
  run = runBoundedCommand,
}) {
  copyFileSync(source, probe);
  try {
    const result = await run(
      'codesign',
      ['--force', '--sign', identity, '--timestamp=none', probe],
      {
        phase: 'macOS private-key readiness probe',
        timeoutMs: PRIVATE_KEY_PROBE_TIMEOUT_MS,
      },
    );
    if (result?.status !== 0) throw new Error('codesign returned nonzero.');
  } catch {
    throw new Error(
      'macOS private-key readiness probe failed before timestamp signing.',
    );
  } finally {
    rmSync(probe, { force: true });
  }
}

export async function cleanupMacosSigningKeychain({ keychain, state, run }) {
  const prepared = existsSync(state);
  const failures = [];
  try {
    const parsed = JSON.parse(readFileSync(state, 'utf8'));
    const { previous, stage } = parsed;
    if (
      ['search-restore-required', 'search-set'].includes(stage) &&
      Array.isArray(previous)
    )
      await security(
        'restore search list',
        ['list-keychains', '-d', 'user', '-s', ...previous],
        run,
      );
    else if (!['captured', 'created'].includes(stage)) failures.push('state');
  } catch {
    if (prepared) failures.push('restore');
  }
  try {
    await security('lock', ['lock-keychain', keychain], run);
  } catch {
    if (prepared) failures.push('lock');
  }
  try {
    await security('delete', ['delete-keychain', keychain], run);
  } catch {
    if (prepared) failures.push('delete');
  }
  if (failures.length)
    throw new Error('macOS signing keychain cleanup failed.');
  rmSync(state, { force: true });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [mode, ...raw] = process.argv.slice(2);
  const keys = raw.filter((_, index) => index % 2 === 0);
  const values = Object.fromEntries(
    keys.map((key, index) => [key.slice(2), raw[index * 2 + 1]]),
  );
  if (
    raw.length % 2 ||
    new Set(keys).size !== keys.length ||
    Object.keys(values).some(
      (key) =>
        ![
          'certificate',
          'deadline-epoch',
          'keychain',
          'probe',
          'state',
        ].includes(key),
    )
  )
    throw new Error('Expected unique known non-secret arguments.');
  const common = {
    identity: process.env.APPLE_DEVELOPER_ID_SIGNING_IDENTITY,
    keychain: values.keychain,
    password: process.env.APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD,
  };
  if (
    !common.keychain ||
    ((mode === 'prepare' || mode === 'unlock') &&
      (!common.identity || !common.password)) ||
    (mode === 'probe' && !common.identity)
  )
    throw new Error('Expected required signing environment inputs.');
  if (mode === 'prepare')
    await prepareMacosSigningKeychain({
      ...common,
      certificate: values.certificate,
      deadlineEpoch: values['deadline-epoch'],
      state: values.state,
    });
  else if (mode === 'unlock')
    await unlockMacosSigningKeychain({
      ...common,
      deadlineEpoch: values['deadline-epoch'],
    });
  else if (mode === 'probe')
    await probeMacosPrivateKey({ ...common, probe: values.probe });
  else if (mode === 'cleanup')
    await cleanupMacosSigningKeychain({
      keychain: values.keychain,
      state: values.state,
    });
  else throw new Error('Expected prepare, unlock, probe, or cleanup mode.');
}
