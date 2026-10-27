import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { runStationsCommand } from '../commands/profile-command.js';
import {
  getProfileCredentialStore,
  setProfileCredentialStore,
} from '../commands/profile-credentials.js';
import { createProfileKeyringStore } from '../commands/profile-keyring.js';
import { KeychainAccessError } from '../commands/profile-keyring-macos.js';
import { upsertProfile } from '../commands/profile-store.js';

/**
 * Stand-in for Apple's /usr/bin/security with the real tool's observable
 * contract: attribute-only lookups print attributes, `-w` prints the secret
 * plus a newline, a missing item exits 44 (errSecItemNotFound & 0xff), a
 * denied dialog exits 128 (errSecUserCanceled & 0xff), and `-i` reads one
 * command per line from stdin. `prompt` simulates an unanswered access dialog
 * on any decrypting operation; `deny` simulates the user pressing Deny.
 */
const FAKE_SECURITY = `#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$*" >> "$dir/calls.log"
notfound() {
  echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2
  exit 44
}
if [ "$1" = "-i" ]; then
  read -r verb update sflag svc aflag acct wflag secret
  [ -f "$dir/prompt" ] && [ -f "$dir/items/$acct" ] && exec sleep 30
  printf '%s' "$secret" > "$dir/items/$acct"
  exit 0
fi
acct="$5"
case "$1" in
  find-generic-password)
    [ -f "$dir/items/$acct" ] || notfound
    if [ "$6" = "-w" ]; then
      [ -f "$dir/prompt" ] && exec sleep 30
      if [ -f "$dir/deny" ]; then
        echo 'security: SecKeychainItemCopyContent: User canceled the operation.' >&2
        exit 128
      fi
      cat "$dir/items/$acct"; echo
      exit 0
    fi
    echo 'keychain: "/Users/fixture/Library/Keychains/login.keychain-db"'
    echo 'version: 512'
    echo 'class: "genp"'
    echo 'attributes:'
    echo "    \\"acct\\"<blob>=\\"$acct\\""
    echo "    \\"svce\\"<blob>=\\"$3\\""
    exit 0 ;;
  delete-generic-password)
    [ -f "$dir/prompt" ] && [ -f "$dir/items/$acct" ] && exec sleep 30
    [ -f "$dir/items/$acct" ] || notfound
    rm "$dir/items/$acct"
    exit 0 ;;
esac
exit 1
`;

const ref = { kind: 'station-bearer' as const, id: 'local-grant:4b8f' };
const account = 'profile:station-bearer:local-grant:4b8f';
const credential = 'stn_Zm9vYmFyYmF6cXV4LWJhc2U2NHVybF9zZWNyZXQ';

let dir: string;
let securityPath: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;
const previousStore = getProfileCredentialStore();

function calls(): string[] {
  const log = join(dir, 'calls.log');
  return existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

function store(timeoutMs?: number) {
  return createProfileKeyringStore({
    platform: 'darwin',
    interactive: false,
    securityPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const makeTempDir = trackTempDirs();

beforeEach(() => {
  dir = makeTempDir('station-keychain-');
  mkdirSync(join(dir, 'items'));
  mkdirSync(join(dir, 'home'));
  securityPath = join(dir, 'security');
  writeFileSync(securityPath, FAKE_SECURITY);
  chmodSync(securityPath, 0o755);
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = join(dir, 'home');
  process.env.STATION_ROOT = join(dir, 'home');
});

afterEach(() => {
  setProfileCredentialStore(previousStore);
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
});

describe('macOS Keychain store through the security tool', () => {
  it('round-trips a credential without putting the secret in argv', () => {
    const keychain = store();
    expect(keychain.status(ref)).toBe('missing');
    expect(keychain.get(ref)).toBeUndefined();

    keychain.set(ref, credential);
    expect(readFileSync(join(dir, 'items', account), 'utf8')).toBe(credential);
    expect(keychain.status(ref)).toBe('available');
    expect(keychain.get(ref)).toBe(credential);

    keychain.delete(ref);
    expect(keychain.status(ref)).toBe('missing');
    // Deleting an absent credential is not an error, matching the native addon.
    keychain.delete(ref);

    expect(calls()).toContain('-i');
    expect(calls()).toContain(
      `find-generic-password -s io.kontourai.station -a ${account} -w`,
    );
    for (const line of calls()) expect(line).not.toContain(credential);
  });

  it('reports credential status without decrypting, so a pending dialog cannot block it', () => {
    const keychain = store(30_000);
    keychain.set(ref, credential);
    writeFileSync(join(dir, 'prompt'), '');
    const started = Date.now();
    expect(keychain.status(ref)).toBe('available');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls().filter((line) => line.endsWith('-w'))).toEqual([]);
  });

  it('lists saved Stations while the Keychain would prompt for the secret', async () => {
    store().set(ref, credential);
    writeFileSync(join(dir, 'prompt'), '');
    upsertProfile({
      name: 'box',
      endpoint: 'https://box.example.test',
      credentialRef: ref,
      makeDefault: true,
    });
    setProfileCredentialStore(store(30_000));
    const lines: string[] = [];
    const started = Date.now();
    await runStationsCommand(['list'], { stdout: (line) => lines.push(line) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lines.join('\n')).toMatch(
      /\* box\s+https:\/\/box\.example\.test\s+available/,
    );
  });

  it('fails a blocked secret read fast with the cause and remedy', () => {
    const keychain = store(400);
    keychain.set(ref, credential);
    writeFileSync(join(dir, 'prompt'), '');
    const started = Date.now();
    let caught: unknown;
    try {
      keychain.get(ref);
    } catch (error) {
      caught = error;
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(caught).toBeInstanceOf(KeychainAccessError);
    const message = (caught as Error).message;
    expect(message).toContain(
      `while reading the Station credential "${account}"`,
    );
    expect(message).toContain('non-interactive shell cannot answer');
    expect(message).toContain('"Always Allow"');
    expect(message).toContain('security unlock-keychain');
    expect(message).not.toContain(credential);
  });

  it.each([
    ['an SSH session', { SSH_CONNECTION: '10.0.0.2 52000 10.0.0.1 22' }, true],
    ['a local terminal', {}, false],
  ])(
    'with a TTY, %s gets the wait that matches who can answer the dialog',
    (_where, env, viaSsh) => {
      const keychain = createProfileKeyringStore({
        platform: 'darwin',
        stdinIsTTY: true,
        env,
        securityPath,
        timeoutMs: 400,
      });
      keychain.set(ref, credential);
      writeFileSync(join(dir, 'prompt'), '');
      expect(() => keychain.get(ref)).toThrow(
        viaSsh
          ? 'non-interactive shell cannot answer'
          : 'that was not answered',
      );
    },
  );

  it('bounds a non-interactive read by default', () => {
    store().set(ref, credential);
    writeFileSync(join(dir, 'prompt'), '');
    const keychain = createProfileKeyringStore({
      platform: 'darwin',
      interactive: false,
      securityPath,
    });
    const started = Date.now();
    expect(() => keychain.get(ref)).toThrow(/did not answer within 5s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('reports a denied dialog as denial, not as a missing credential', () => {
    const keychain = store();
    keychain.set(ref, credential);
    writeFileSync(join(dir, 'deny'), '');
    expect(() => keychain.get(ref)).toThrow(/access was denied/);
  });

  it('refuses a value the security tool would have to parse with quoting', () => {
    const keychain = store();
    expect(() => keychain.set(ref, "abc' -A")).toThrow(
      /credential contains characters/,
    );
    expect(() => keychain.set(ref, 'x'.repeat(5000))).toThrow(
      /4096-byte command limit/,
    );
    expect(calls()).toEqual([]);
  });

  it('treats a missing security tool as an unavailable keyring', () => {
    securityPath = join(dir, 'absent-security');
    const keychain = store();
    expect(keychain.status(ref)).toBe('unavailable');
    expect(() => keychain.get(ref)).toThrow(/could not run/);
  });
});
