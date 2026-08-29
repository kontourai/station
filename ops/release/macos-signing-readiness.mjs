import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { signingIdentityRecordsFromSecurityOutput } from '../nightly/macos-signing-identity.mjs';
import { runBoundedCommand } from './macos-notarized-artifacts.mjs';

export const KEYCHAIN_UNLOCK_LIFETIME_SECONDS = 105 * 60;
export const PRIVATE_KEY_PROBE_TIMEOUT_MS = 60 * 1000;
const SIGNING_KEYCHAIN_JOURNAL_VERSION = 1;
const MAX_KEYCHAIN_PATH_LENGTH = 4096;
const MAX_SEARCH_LIST_ENTRIES = 128;

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
  const lines = (
    await security('capture search list', ['list-keychains', '-d', 'user'], run)
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  return validatedKeychainPaths(lines.map(decodeSecurityKeychainPath));
}

function exactIdentityMatches(output, identity) {
  return signingIdentityRecordsFromSecurityOutput(output).filter(
    (candidate) => candidate.name === identity,
  ).length;
}

function decodeSecurityKeychainPath(line) {
  const trimmed = line.trim();
  if (!trimmed) throw new Error('A macOS keychain search-list entry is empty.');
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const decoded = JSON.parse(trimmed);
    if (typeof decoded !== 'string') throw new Error('not a string');
    return decoded;
  } catch {
    throw new Error('A macOS keychain search-list entry is malformed.');
  }
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function validatedKeychainPaths(previous) {
  if (!Array.isArray(previous) || previous.length > MAX_SEARCH_LIST_ENTRIES)
    throw new Error('macOS keychain search-list state is invalid.');
  const seen = new Set();
  for (const path of previous) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_KEYCHAIN_PATH_LENGTH ||
      hasControlCharacters(path) ||
      !isAbsolute(path) ||
      seen.has(path)
    )
      throw new Error('macOS keychain search-list state is invalid.');
    seen.add(path);
  }
  return previous;
}

function validatedSigningKeychainJournal(parsed, keychain) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('macOS signing keychain journal is invalid.');
  const keys = Object.keys(parsed).sort();
  if (
    keys.join(',') !== 'keychain,previous,schemaVersion,stage' ||
    parsed.schemaVersion !== SIGNING_KEYCHAIN_JOURNAL_VERSION ||
    parsed.keychain !== keychain ||
    !['captured', 'created', 'search-restore-required', 'search-set'].includes(
      parsed.stage,
    )
  )
    throw new Error('macOS signing keychain journal is invalid.');
  return {
    previous: validatedKeychainPaths(parsed.previous),
    stage: parsed.stage,
  };
}

function persistSigningKeychainState({ state, keychain, previous, stage }) {
  writeFileSync(
    state,
    JSON.stringify({
      keychain,
      previous,
      schemaVersion: SIGNING_KEYCHAIN_JOURNAL_VERSION,
      stage,
    }),
    {
      mode: 0o600,
    },
  );
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
  const lifetime = lifetimeFromDeadline(deadlineEpoch, now);
  const previous = await previousSearchList(run);
  writeState({ keychain, previous, state, stage: 'captured' });
  await security('create', ['create-keychain', '-p', password, keychain], run);
  writeState({ keychain, previous, state, stage: 'created' });
  await security(
    'set bounded lifetime',
    ['set-keychain-settings', '-lut', String(lifetime), keychain],
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
  const lifetime = lifetimeFromDeadline(deadlineEpoch, now);
  await security(
    'refresh bounded lifetime',
    ['set-keychain-settings', '-lut', String(lifetime), keychain],
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
  copy = copyFileSync,
}) {
  try {
    copy(source, probe);
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
  let journal;
  if (prepared) {
    try {
      journal = validatedSigningKeychainJournal(
        JSON.parse(readFileSync(state, 'utf8')),
        keychain,
      );
    } catch {
      throw new Error('macOS signing keychain cleanup failed.');
    }
  }
  if (prepared) {
    const { previous, stage } = journal;
    try {
      if (['search-restore-required', 'search-set'].includes(stage))
        await security(
          'restore search list',
          ['list-keychains', '-d', 'user', '-s', ...previous],
          run,
        );
    } catch {
      failures.push('restore');
    }
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

const CLI_MODE_ARGUMENTS = Object.freeze({
  cleanup: Object.freeze(['keychain', 'state']),
  prepare: Object.freeze([
    'certificate',
    'deadline-epoch',
    'keychain',
    'state',
  ]),
  probe: Object.freeze(['keychain', 'probe']),
  unlock: Object.freeze(['deadline-epoch', 'keychain']),
});

function exactCliArguments(mode, raw) {
  const expected = CLI_MODE_ARGUMENTS[mode];
  if (!expected || raw.length !== expected.length * 2)
    throw new Error('Expected exact mode-specific non-secret arguments.');
  const values = {};
  for (let index = 0; index < raw.length; index += 2) {
    const flag = raw[index];
    const value = raw[index + 1];
    if (
      typeof flag !== 'string' ||
      !/^--[a-z][a-z-]*$/.test(flag) ||
      typeof value !== 'string' ||
      value.length === 0
    )
      throw new Error('Expected exact mode-specific non-secret arguments.');
    const key = flag.slice(2);
    if (!expected.includes(key) || Object.hasOwn(values, key))
      throw new Error('Expected exact mode-specific non-secret arguments.');
    values[key] = value;
  }
  if (expected.some((key) => !Object.hasOwn(values, key)))
    throw new Error('Expected exact mode-specific non-secret arguments.');
  if (
    Object.hasOwn(values, 'deadline-epoch') &&
    !/^[1-9][0-9]{9,10}$/.test(values['deadline-epoch'])
  )
    throw new Error('Expected exact mode-specific non-secret arguments.');
  return values;
}

export function parseMacosSigningReadinessCli({
  mode,
  raw,
  env = process.env,
}) {
  const values = exactCliArguments(mode, raw);
  const identity = env.APPLE_DEVELOPER_ID_SIGNING_IDENTITY;
  const password = env.APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD;
  if (
    ['prepare', 'unlock', 'probe'].includes(mode) &&
    (typeof identity !== 'string' || identity.length === 0)
  )
    throw new Error('Expected required signing environment inputs.');
  if (
    ['prepare', 'unlock'].includes(mode) &&
    (typeof password !== 'string' || password.length === 0)
  )
    throw new Error('Expected required signing environment inputs.');
  return { identity, mode, password, values };
}

export async function runMacosSigningReadinessCli({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const [mode, ...raw] = argv;
  const { identity, password, values } = parseMacosSigningReadinessCli({
    env,
    mode,
    raw,
  });
  const common = { identity, keychain: values.keychain, password };
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
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await runMacosSigningReadinessCli();
