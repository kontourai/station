import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { runBoundedCommand } from './macos-notarized-artifacts.mjs';

export const KEYCHAIN_UNLOCK_LIFETIME_SECONDS = 105 * 60;
export const PRIVATE_KEY_PROBE_TIMEOUT_MS = 60 * 1000;

async function security(phase, args, run = runBoundedCommand) {
  try {
    return await run('security', args, {
      phase: `macOS signing keychain ${phase}`,
      timeoutMs: PRIVATE_KEY_PROBE_TIMEOUT_MS,
    });
  } catch {
    throw new Error('macOS signing keychain operation failed.');
  }
}

async function previousSearchList(run) {
  return (await security('capture search list', ['list-keychains', '-d', 'user'], run)).stdout
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

export async function prepareMacosSigningKeychain({
  certificate,
  identity,
  keychain,
  password,
  state,
  run,
}) {
  const previous = await previousSearchList(run);
  await security('create', ['create-keychain', '-p', password, keychain], run);
  await security('set bounded lifetime', ['set-keychain-settings', '-lut', String(KEYCHAIN_UNLOCK_LIFETIME_SECONDS), keychain], run);
  await security('unlock', ['unlock-keychain', '-p', password, keychain], run);
  await security('import', ['import', certificate, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'], run);
  // Retain the existing least-privilege partition set; do not broaden it with
  // an unqualified codesign: entry when a Developer-ID P12 may hold two keys.
  await security('set partition list', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain], run);
  const matches = exactIdentityMatches((await security('validate identity', ['find-identity', '-v', '-p', 'codesigning', keychain], run)).stdout, identity);
  if (matches !== 1) throw new Error('Configured Developer ID signing identity is not uniquely available.');
  writeFileSync(state, JSON.stringify({ keychain, previous }), { mode: 0o600 });
  await security('set search list', ['list-keychains', '-d', 'user', '-s', keychain], run);
}

export async function unlockMacosSigningKeychain({ identity, keychain, password, run }) {
  await security('re-unlock', ['unlock-keychain', '-p', password, keychain], run);
  const matches = exactIdentityMatches((await security('validate identity', ['find-identity', '-v', '-p', 'codesigning', keychain], run)).stdout, identity);
  if (matches !== 1) throw new Error('Configured Developer ID signing identity is not uniquely available.');
}

export async function probeMacosPrivateKey({
  identity,
  probe,
  source = '/usr/bin/true',
  run = runBoundedCommand,
}) {
  copyFileSync(source, probe);
  try {
    await run('codesign', ['--force', '--sign', identity, '--timestamp=none', probe], {
      phase: 'macOS private-key readiness probe',
      timeoutMs: PRIVATE_KEY_PROBE_TIMEOUT_MS,
    });
  } catch {
    throw new Error('macOS private-key readiness probe failed before timestamp signing.');
  } finally {
    rmSync(probe, { force: true });
  }
}

export async function cleanupMacosSigningKeychain({ keychain, state, run }) {
  try {
    const previous = JSON.parse(readFileSync(state, 'utf8')).previous;
    if (Array.isArray(previous) && previous.length)
      await security('restore search list', ['list-keychains', '-d', 'user', '-s', ...previous], run);
  } catch {
    // Never replace an unknown caller search list during cleanup.
  }
  try { await security('lock', ['lock-keychain', keychain], run); } catch {}
  try { await security('delete', ['delete-keychain', keychain], run); } catch {}
  rmSync(state, { force: true });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [mode, ...raw] = process.argv.slice(2);
  const keys = raw.filter((_, index) => index % 2 === 0);
  const values = Object.fromEntries(keys.map((key, index) => [key.slice(2), raw[index * 2 + 1]]));
  if (raw.length % 2 || new Set(keys).size !== keys.length || Object.keys(values).some((key) => !['certificate', 'keychain', 'probe', 'state'].includes(key))) throw new Error('Expected unique known non-secret arguments.');
  const common = { identity: process.env.APPLE_DEVELOPER_ID_SIGNING_IDENTITY, keychain: values.keychain, password: process.env.APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD };
  if (!common.keychain || ((mode === 'prepare' || mode === 'unlock') && (!common.identity || !common.password)) || (mode === 'probe' && !common.identity)) throw new Error('Expected required signing environment inputs.');
  if (mode === 'prepare') await prepareMacosSigningKeychain({ ...common, certificate: values.certificate, state: values.state });
  else if (mode === 'unlock') await unlockMacosSigningKeychain(common);
  else if (mode === 'probe') await probeMacosPrivateKey({ ...common, probe: values.probe });
  else if (mode === 'cleanup') await cleanupMacosSigningKeychain({ keychain: values.keychain, state: values.state });
  else throw new Error('Expected prepare, unlock, probe, or cleanup mode.');
}
