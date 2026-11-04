import { spawnSync } from 'node:child_process';
import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import type { ProfileCredentialStore } from './profile-credentials.js';

/**
 * macOS Keychain access through Apple's signed `/usr/bin/security` tool.
 *
 * Why not the in-process native addon: a Keychain item's access list trusts
 * the *application* that created it, and for an in-process addon that is the
 * `node` binary running the CLI. Every Station nightly ships a new node under
 * a versioned runtime path, and a contributor checkout runs yet another node,
 * so each upgrade or caller became an untrusted app and macOS showed an access
 * dialog. Run from a non-interactive shell, nobody could answer it and the
 * CLI hung. `/usr/bin/security` is a stable, Apple-signed path (the approach
 * `gh` takes through go-keyring), so one "Always Allow" survives upgrades.
 *
 * Every call is bounded: a timeout kills the child (which also withdraws its
 * pending dialog) and reports the cause instead of blocking forever.
 */

const MACOS_SECURITY_TOOL = '/usr/bin/security';
/** `security` exits 44 for errSecItemNotFound. */
const ITEM_NOT_FOUND_EXIT = 44;
/** `security` exits 128 when the user denies or cancels the access dialog. */
const USER_CANCELED_EXIT = 128;
/**
 * A prompt-free Keychain call completes in tens of milliseconds, so a
 * non-interactive caller that exceeds this is waiting on a dialog nobody can
 * answer. An interactive caller gets time to find and answer that dialog.
 */
const NON_INTERACTIVE_KEYCHAIN_TIMEOUT_MS = 5_000;
const INTERACTIVE_KEYCHAIN_TIMEOUT_MS = 120_000;
/** `security -i` reads one command per line into a 4096-byte buffer. */
const INTERACTIVE_LINE_LIMIT_BYTES = 4096;
/**
 * Tokens `security -i` parses verbatim without quoting (the same set
 * go-keyring's shell quoting leaves bare). Anything else is refused rather
 * than relying on the tool's undocumented quote handling.
 */
const BARE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MAX_CAPTURE_BYTES = 64 * 1024;

export interface MacosKeychainStoreOptions {
  service: string;
  account: (ref: StationProfileCredentialRef) => string;
  interactive: boolean;
  /** Test seam: replaces `/usr/bin/security` with a fixture executable. */
  securityPath?: string;
  /** Test seam: overrides the interactivity-derived bound. */
  timeoutMs?: number;
}

export class KeychainAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainAccessError';
  }
}

interface SecurityResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

export function createMacosKeychainStore(
  options: MacosKeychainStoreOptions,
): ProfileCredentialStore {
  const securityPath = options.securityPath ?? MACOS_SECURITY_TOOL;
  const timeoutMs =
    options.timeoutMs ??
    (options.interactive
      ? INTERACTIVE_KEYCHAIN_TIMEOUT_MS
      : NON_INTERACTIVE_KEYCHAIN_TIMEOUT_MS);

  function run(args: string[], input?: string): SecurityResult {
    const result = spawnSync(securityPath, args, {
      encoding: 'utf8',
      input: input ?? '',
      timeout: timeoutMs,
      // A dialog-blocked child must not outlive the bound.
      killSignal: 'SIGKILL',
      maxBuffer: MAX_CAPTURE_BYTES,
      windowsHide: true,
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: errorCode === 'ETIMEDOUT',
      ...(result.error && errorCode !== 'ETIMEDOUT'
        ? { spawnError: result.error }
        : {}),
    };
  }

  function failure(
    operation: string,
    account: string,
    result: SecurityResult,
  ): KeychainAccessError {
    const subject = `the Station credential "${account}"`;
    if (result.timedOut) {
      const seconds = Math.round(timeoutMs / 1000);
      return new KeychainAccessError(
        `macOS Keychain did not answer within ${seconds}s while ${operation} ${subject}. ` +
          'macOS is most likely waiting for approval in a Keychain access dialog' +
          (options.interactive
            ? ' that was not answered, or the login keychain is locked.'
            : ', which this non-interactive shell cannot answer, or the login keychain is locked.') +
          ' Run the same station command once in an interactive terminal at this Mac and choose "Always Allow" when macOS asks whether "security" may use the item; later runs, including non-interactive ones, then read it without a dialog. If the keychain is locked, unlock it first (security unlock-keychain).',
      );
    }
    if (result.spawnError) {
      return new KeychainAccessError(
        `macOS Keychain is unavailable while ${operation} ${subject}: could not run ${securityPath} (${result.spawnError.message}).`,
      );
    }
    if (result.status === USER_CANCELED_EXIT) {
      return new KeychainAccessError(
        `macOS Keychain access was denied while ${operation} ${subject}. Run the command again and choose "Always Allow" when macOS asks whether "security" may use the item.`,
      );
    }
    const detail = result.stderr.trim().split('\n')[0] || 'no detail';
    return new KeychainAccessError(
      `macOS Keychain refused ${operation} ${subject} (security exited ${result.status ?? 'without a status'}: ${detail}).`,
    );
  }

  function lookupArgs(ref: StationProfileCredentialRef): string[] {
    return [
      'find-generic-password',
      '-s',
      options.service,
      '-a',
      options.account(ref),
    ];
  }

  return {
    get(ref) {
      const account = options.account(ref);
      // `-w` decrypts the secret: the only read that consults the item's ACL.
      const result = run([...lookupArgs(ref), '-w']);
      if (result.status === 0 && !result.timedOut && !result.spawnError) {
        return result.stdout.endsWith('\n')
          ? result.stdout.slice(0, -1)
          : result.stdout;
      }
      if (result.status === ITEM_NOT_FOUND_EXIT) return undefined;
      throw failure('reading', account, result);
    },
    set(ref, credential) {
      const account = options.account(ref);
      for (const [label, value] of [
        ['service', options.service],
        ['account', account],
        ['credential', credential],
      ] as const) {
        if (!BARE_TOKEN.test(value))
          throw new KeychainAccessError(
            `Station refused to store ${account}: the ${label} contains characters the macOS security tool cannot accept unquoted.`,
          );
      }
      // The secret travels on stdin, never argv, so `ps` cannot observe it.
      const line = `add-generic-password -U -s ${options.service} -a ${account} -w ${credential}\n`;
      if (Buffer.byteLength(line) > INTERACTIVE_LINE_LIMIT_BYTES)
        throw new KeychainAccessError(
          `Station refused to store ${account}: the credential exceeds the macOS security tool's ${INTERACTIVE_LINE_LIMIT_BYTES}-byte command limit.`,
        );
      const result = run(['-i'], line);
      if (result.status === 0 && !result.timedOut && !result.spawnError) return;
      throw failure('storing', account, result);
    },
    delete(ref) {
      const account = options.account(ref);
      const result = run([
        'delete-generic-password',
        '-s',
        options.service,
        '-a',
        account,
      ]);
      if (
        (result.status === 0 || result.status === ITEM_NOT_FOUND_EXIT) &&
        !result.timedOut &&
        !result.spawnError
      )
        return;
      throw failure('deleting', account, result);
    },
    status(ref) {
      // Attribute-only lookup: without -w/-g the secret is never decrypted,
      // so the access list is not consulted and no dialog can appear.
      const result = run(lookupArgs(ref));
      if (result.timedOut || result.spawnError) return 'unavailable';
      if (result.status === 0) return 'available';
      if (result.status === ITEM_NOT_FOUND_EXIT) return 'missing';
      return 'unavailable';
    },
  };
}
