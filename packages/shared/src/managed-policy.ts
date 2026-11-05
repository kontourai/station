/**
 * Reading the managed policy (#4515) from where an administrator installs it.
 *
 * The document shape, its parser and the client summary live in
 * `@kontourai/station-contracts/managed-policy`. This module owns the Node
 * side: the fixed per-OS file path, the source abstraction, the system
 * sources (the file, a macOS configuration profile, the Windows registry),
 * the test override, the fingerprint, and the one error every failure
 * becomes.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  canonicalManagedPolicyJson,
  duplicateJsonMemberPath,
  formatManagedPolicyProblems,
  MANAGED_POLICY_INVALID_MARKER,
  type ManagedPolicyDigest,
  type ManagedPolicyDocument,
  type ManagedPolicyProblem,
  type ManagedPolicySourceDescriptor,
  type ManagedPolicyStatus,
  type ManagedPolicySummary,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import {
  registryPolicyInput,
  WINDOWS_POLICY_KEY,
  WINDOWS_POLICY_SUBKEY,
} from './managed-policy-controls.js';
import {
  duplicatePlistKeyPath,
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPreferencesDocument,
  type PlistConverter,
  plutilConverter,
} from './managed-policy-macos.js';
import {
  koffiWindowsSecurityApi,
  type WindowsSecurityApi,
  windowsKeyChainProblem,
  windowsPathChainProblem,
} from './managed-policy-windows.js';

/**
 * The test-only override: an absolute path to a policy file. It is honored
 * only when no system source is installed; with one installed it is a
 * startup error, so it can never replace or hide an administrator's policy.
 * See docs/decisions/managed-policy.md.
 */
export const MANAGED_POLICY_TEST_FILE_ENV = 'STATION_MANAGED_POLICY_TEST_FILE';

/** Larger than any real policy; a bigger file is refused, not truncated. */
export const MANAGED_POLICY_MAX_BYTES = 1024 * 1024;

/**
 * The system path an administrator installs the policy file to. Fixed
 * literals on purpose: an environment-expanded location such as
 * `%ProgramFiles%` or `%ProgramData%` can be redirected by the user, or
 * created first and owned by them, which would let them choose the policy.
 */
export function managedPolicyFilePath(
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/Station/policy.json';
    case 'win32':
      return 'C:\\Program Files\\Station\\policy.json';
    default:
      return '/etc/station/policy.json';
  }
}

/** Bounds for the parts of the fatal line that come from outside Station. */
export const MANAGED_POLICY_LOCATION_MAX_CHARS = 1024;
export const MANAGED_POLICY_REASON_MAX_CHARS = 2048;

/**
 * One line of at most `max` characters. The fatal message is read by the
 * desktop sidecar from a bounded stderr capture and matched by its leading
 * marker, so neither a long policy key nor a newline in a path may push the
 * marker out of view or split the line.
 */
function boundedLine(text: string, max: number): string {
  const line = text.replace(/[\r\n]+/g, ' ');
  if (line.length <= max) return line;
  const note = `… (${line.length - max} more characters)`;
  return `${line.slice(0, max)}${note}`;
}

export class ManagedPolicyInvalidError extends Error {
  readonly code = MANAGED_POLICY_INVALID_MARKER;
  /** The source location(s) at fault, for the administrator; bounded. */
  readonly location: string;
  /** Why the policy cannot be used; bounded. */
  readonly reason: string;

  constructor(
    location: string,
    reason: string,
    readonly problems: readonly ManagedPolicyProblem[] = [],
  ) {
    const boundedLocation = boundedLine(
      location,
      MANAGED_POLICY_LOCATION_MAX_CHARS,
    );
    const boundedReason = boundedLine(reason, MANAGED_POLICY_REASON_MAX_CHARS);
    super(
      `${MANAGED_POLICY_INVALID_MARKER}: Station cannot use the managed policy at ${boundedLocation}: ${boundedReason}. Station will not start until an administrator fixes or removes it.`,
    );
    this.name = 'ManagedPolicyInvalidError';
    this.location = boundedLocation;
    this.reason = boundedReason;
  }
}

/**
 * What a source yields when it holds a policy: JSON text (a file, a registry
 * string) or a value a native reader already decoded (a profile's plist).
 */
export type ManagedPolicyRawInput =
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: unknown };

export interface ManagedPolicySource {
  readonly descriptor: ManagedPolicySourceDescriptor;
  /**
   * The raw policy, or undefined when this source holds none. Any other
   * failure (unreadable, not a file, too large) throws
   * {@link ManagedPolicyInvalidError}: an administrator's policy that cannot
   * be read must never read as "no policy".
   */
  read(): ManagedPolicyRawInput | undefined;
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function unreadableReason(error: unknown): string {
  const code = errnoCode(error);
  if (code === 'EISDIR') return 'it is a directory, not a file';
  if (code === 'EACCES' || code === 'EPERM')
    return 'the file cannot be read (permission denied)';
  return `the file cannot be read (${code ?? 'unknown error'})`;
}

/**
 * Who must own a system policy file and every directory above it. The
 * default is root with no group or other write bit, which a stock macOS
 * (`/Library` is root:wheel 0755, `/Library/Application Support` is
 * root:admin 0755) and Linux (`/etc` is root:root 0755) already satisfy:
 * the group is not checked, only that it cannot write. Tests stop the walk
 * at a directory they own; production walks to `/`.
 */
export interface ManagedPolicyFileOwnership {
  ownerUid: number;
  /** The highest directory checked, inclusive. */
  trustedRoot: string;
  /**
   * Windows: where owners and ACLs are read from. Unset means the Win32 API
   * of this process; tests substitute a fake.
   */
  windowsSecurity?: WindowsSecurityApi;
}

let defaultWindowsSecurity: WindowsSecurityApi | undefined;

/** The Win32 reader this process uses, created on first use. */
export function processWindowsSecurityApi(): WindowsSecurityApi {
  defaultWindowsSecurity ??= koffiWindowsSecurityApi();
  return defaultWindowsSecurity;
}

export const SYSTEM_MANAGED_POLICY_OWNERSHIP: ManagedPolicyFileOwnership = {
  ownerUid: 0,
  trustedRoot: '/',
};

const GROUP_OR_OTHER_WRITE = 0o022;

function ownerName(uid: number): string {
  return uid === 0 ? 'root (uid 0)' : `uid ${uid}`;
}

function ownershipProblem(
  target: string,
  stats: { uid: number; mode: number },
  ownership: ManagedPolicyFileOwnership,
  checkMode: boolean,
): string | null {
  if (stats.uid !== ownership.ownerUid)
    return `${target} must be owned by ${ownerName(ownership.ownerUid)}, but is owned by uid ${stats.uid}`;
  if (checkMode && (stats.mode & GROUP_OR_OTHER_WRITE) !== 0)
    return `${target} must not be writable by its group or other users (mode ${(stats.mode & 0o7777).toString(8)})`;
  return null;
}

function ancestorsUpTo(start: string, root: string): string[] | null {
  const chain: string[] = [];
  let current = start;
  for (;;) {
    chain.push(current);
    if (current === root) return chain;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Refuse a policy whose directory chain someone other than the owner could
 * change: a writable directory lets its writers swap the file for their own.
 * The literal chain is checked with `lstat` (a symbolic link's own mode
 * means nothing, so only its owner is checked), and the resolved chain is
 * checked too, so a root-owned link cannot lead into a user's directory.
 *
 * Windows has no uid or mode bits; the file source checks owners and ACLs
 * there instead, with `windowsPathChainProblem` (#4524).
 */
export function managedPolicyDirectoryProblem(
  directory: string,
  ownership: ManagedPolicyFileOwnership,
): string | null {
  const root = resolve(ownership.trustedRoot);
  const literal = ancestorsUpTo(resolve(directory), root);
  let realRoot: string;
  let real: string[] | null;
  try {
    realRoot = realpathSync(root);
    real = ancestorsUpTo(realpathSync(directory), realRoot);
  } catch (error) {
    return `${directory} cannot be resolved (${errnoCode(error) ?? 'unknown error'})`;
  }
  if (!literal || !real) return `${directory} is not under ${root}`;
  for (const [chain, resolved] of [
    [literal, false],
    [real, true],
  ] as const) {
    for (const entry of chain) {
      let stats: Stats;
      try {
        stats = lstatSync(entry);
      } catch (error) {
        return `${entry} cannot be inspected (${errnoCode(error) ?? 'unknown error'})`;
      }
      if (resolved && !stats.isDirectory())
        return `${entry} is not a directory`;
      const problem = ownershipProblem(
        entry,
        stats,
        ownership,
        !stats.isSymbolicLink(),
      );
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Why a file outside the policy (a program Station trusts to answer for the
 * system, #4519) cannot be trusted the way a policy file is, or `null`.
 * `undefined` when nothing is at `path`. The literal entry and the file it
 * resolves to must belong to `ownership.ownerUid`; the resolved file must be
 * a regular file nobody else can write. With `directories`, both directory
 * chains are held to `managedPolicyDirectoryProblem` as well; a caller that
 * cannot hold a chain to that (a macOS app under the admin-writable
 * `/Applications`) needs a second authority, such as a code signature.
 */
export function managedTrustedFileProblem(
  path: string,
  ownership: ManagedPolicyFileOwnership,
  options: { directories: boolean },
): string | null | undefined {
  let literal: Stats;
  try {
    literal = lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    return `${path} cannot be inspected (${errnoCode(error) ?? 'unknown error'})`;
  }
  const literalProblem = ownershipProblem(
    path,
    literal,
    ownership,
    !literal.isSymbolicLink(),
  );
  if (literalProblem) return literalProblem;
  let real: string;
  let stats: Stats;
  try {
    real = realpathSync(path);
    stats = lstatSync(real);
  } catch (error) {
    return `${path} cannot be resolved (${errnoCode(error) ?? 'unknown error'})`;
  }
  if (!stats.isFile()) return `${real} is not a regular file`;
  const fileProblem = ownershipProblem(real, stats, ownership, true);
  if (fileProblem || !options.directories) return fileProblem;
  return (
    managedPolicyDirectoryProblem(dirname(path), ownership) ??
    managedPolicyDirectoryProblem(dirname(real), ownership)
  );
}

const SYMLINK_REASON =
  'it is a symbolic link or reparse point; install the policy as a regular file';

/** Rethrow a policy error; turn any other failure into "cannot be read". */
function asPolicyError(
  path: string,
  error: unknown,
): ManagedPolicyInvalidError {
  return error instanceof ManagedPolicyInvalidError
    ? error
    : new ManagedPolicyInvalidError(path, unreadableReason(error));
}

const TOO_LARGE_REASON = `the file is larger than ${MANAGED_POLICY_MAX_BYTES} bytes`;

/**
 * Open the entry at `path` without following a link and without blocking,
 * or return undefined when nothing is there.
 */
function openPolicyEntry(
  path: string,
): { fd: number; entry: Stats } | undefined {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw asPolicyError(path, error);
  }
  // On Windows `lstat` reports symbolic links and junctions this way; there
  // is no O_NOFOLLOW, so this check carries the refusal there.
  if (entry.isSymbolicLink())
    throw new ManagedPolicyInvalidError(path, SYMLINK_REASON);
  if (entry.isDirectory())
    throw new ManagedPolicyInvalidError(path, 'it is a directory, not a file');
  try {
    const fd = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    return { fd, entry };
  } catch (error) {
    // ELOOP: the entry became a link after lstat.
    if (errnoCode(error) === 'ELOOP')
      throw new ManagedPolicyInvalidError(path, SYMLINK_REASON);
    throw asPolicyError(path, error);
  }
}

/** Every check on the opened descriptor, before anything is read. */
function checkOpenedPolicy(
  path: string,
  fd: number,
  entry: Stats,
  ownership: ManagedPolicyFileOwnership | undefined,
): void {
  const stats = fstatSync(fd);
  if (stats.isDirectory())
    throw new ManagedPolicyInvalidError(path, 'it is a directory, not a file');
  if (!stats.isFile())
    throw new ManagedPolicyInvalidError(path, 'it is not a regular file');
  // The opened file must be the entry lstat saw, not one swapped in between
  // (the only link check Windows has).
  if (stats.dev !== entry.dev || stats.ino !== entry.ino)
    throw new ManagedPolicyInvalidError(
      path,
      'it changed while Station was opening it',
    );
  if (ownership) {
    const problem =
      process.platform === 'win32'
        ? windowsPathChainProblem(
            path,
            ownership.windowsSecurity ?? processWindowsSecurityApi(),
          )
        : (ownershipProblem(path, stats, ownership, true) ??
          managedPolicyDirectoryProblem(dirname(path), ownership));
    if (problem) throw new ManagedPolicyInvalidError(path, problem);
  }
  if (stats.size > MANAGED_POLICY_MAX_BYTES)
    throw new ManagedPolicyInvalidError(path, TOO_LARGE_REASON);
}

/**
 * Read to the end, one byte past the limit, so a file that grew after
 * `fstat` is refused rather than silently truncated.
 */
function readPolicyBytes(path: string, fd: number): Buffer {
  const buffer = Buffer.alloc(MANAGED_POLICY_MAX_BYTES + 1);
  let length = 0;
  for (;;) {
    const read = readSync(fd, buffer, length, buffer.length - length, null);
    if (read === 0) break;
    length += read;
    if (length > MANAGED_POLICY_MAX_BYTES)
      throw new ManagedPolicyInvalidError(path, TOO_LARGE_REASON);
  }
  return buffer.subarray(0, length);
}

/**
 * Read a policy file. Only an absent entry means "no policy": a symbolic
 * link is refused, never followed, even when it dangles (a dangling link
 * would otherwise read as absence). The descriptor is opened without
 * following links and without blocking, so a FIFO cannot hang startup. The
 * file checks run on that descriptor; the directory chain is checked by path.
 *
 * With `ownership` (system sources only), the file and each directory up to
 * `ownership.trustedRoot` must belong to the owner and not be writable by
 * anyone else; see {@link managedPolicyDirectoryProblem}.
 */
export function readManagedPolicyFile(
  path: string,
  ownership?: ManagedPolicyFileOwnership,
): ManagedPolicyRawInput | undefined {
  const bytes = readManagedPolicyFileBytes(path, ownership);
  return bytes === undefined
    ? undefined
    : { kind: 'text', text: bytes.toString('utf8') };
}

/**
 * The bytes of a policy file, with every check of
 * {@link readManagedPolicyFile}; undefined when nothing is at `path`.
 */
export function readManagedPolicyFileBytes(
  path: string,
  ownership?: ManagedPolicyFileOwnership,
): Buffer | undefined {
  const opened = openPolicyEntry(path);
  if (!opened) return undefined;
  try {
    checkOpenedPolicy(path, opened.fd, opened.entry, ownership);
    return readPolicyBytes(path, opened.fd);
  } catch (error) {
    throw asPolicyError(path, error);
  } finally {
    closeSync(opened.fd);
  }
}

export function managedPolicyFileSource(
  path: string,
  kind: ManagedPolicySourceDescriptor['kind'] = 'file',
  ownership?: ManagedPolicyFileOwnership,
): ManagedPolicySource {
  return {
    descriptor: { kind, location: path },
    read: () => readManagedPolicyFile(path, ownership),
  };
}

/**
 * The device-level managed preferences a macOS configuration profile
 * installs (#4523). The plist gets the policy file's checks (no link,
 * regular file, root-owned chain), then `/usr/bin/plutil` converts its
 * bytes; the decoded value goes to the same decoder as a file.
 */
export function macosProfileSource(
  path: string = MACOS_MANAGED_PREFERENCES_PATH,
  /** `null` skips the ownership rule; tests only. */
  ownership: ManagedPolicyFileOwnership | null = SYSTEM_MANAGED_POLICY_OWNERSHIP,
  convert: PlistConverter = plutilConverter(),
): ManagedPolicySource {
  return {
    descriptor: { kind: 'macos-profile', location: path },
    read: () => {
      const bytes = readManagedPolicyFileBytes(path, ownership ?? undefined);
      if (bytes === undefined) return undefined;
      if (!bytes.subarray(0, 8).equals(Buffer.from('bplist00'))) {
        const duplicate = duplicatePlistKeyPath(bytes.toString('utf8'));
        if (duplicate !== null)
          throw new ManagedPolicyInvalidError(
            path,
            `duplicate key ${duplicate}`,
          );
      }
      const converted = convert(bytes);
      if (!converted.ok)
        throw new ManagedPolicyInvalidError(path, converted.reason);
      let preferences: unknown;
      try {
        preferences = JSON.parse(converted.json);
      } catch (error) {
        throw new ManagedPolicyInvalidError(
          path,
          `the converted profile is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return { kind: 'value', value: managedPreferencesDocument(preferences) };
    },
  };
}

/**
 * `HKLM\SOFTWARE\Policies\Kontour\Station` (#4524), in the 64-bit view
 * only, read through the Win32 API. An empty key is no policy. A key that
 * holds anything must, with every key above it, be changeable only by
 * Administrators, SYSTEM or TrustedInstaller.
 */
export function windowsRegistrySource(
  api?: WindowsSecurityApi,
): ManagedPolicySource {
  const location = WINDOWS_POLICY_KEY;
  return {
    descriptor: { kind: 'windows-registry', location },
    read: () => {
      const windows = api ?? processWindowsSecurityApi();
      let snapshot: ReturnType<WindowsSecurityApi['readMachineKey']>;
      try {
        snapshot = windows.readMachineKey(
          WINDOWS_POLICY_SUBKEY,
          MANAGED_POLICY_MAX_BYTES,
        );
      } catch (error) {
        throw new ManagedPolicyInvalidError(
          location,
          `the registry cannot be read (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (snapshot === undefined) return undefined;
      const input = registryPolicyInput(snapshot);
      if (input.kind === 'absent') return undefined;
      const problem = windowsKeyChainProblem(WINDOWS_POLICY_SUBKEY, windows);
      if (problem) throw new ManagedPolicyInvalidError(location, problem);
      if (input.kind === 'problem')
        throw new ManagedPolicyInvalidError(location, input.reason);
      return input.kind === 'text'
        ? { kind: 'text', text: input.text }
        : { kind: 'value', value: input.value };
    },
  };
}

/**
 * Every system source on `platform`, in a stable order: the policy file,
 * then the platform's device-management source. More than one holding a
 * policy is a startup error (see {@link loadManagedPolicyFromSources}).
 */
export function systemManagedPolicySources(
  platform: NodeJS.Platform = process.platform,
  filePath: string = managedPolicyFilePath(platform),
): ManagedPolicySource[] {
  const file = managedPolicyFileSource(
    filePath,
    'file',
    SYSTEM_MANAGED_POLICY_OWNERSHIP,
  );
  if (platform === 'darwin') return [file, macosProfileSource()];
  if (platform === 'win32') return [file, windowsRegistrySource()];
  return [file];
}

/** Decode and validate raw input; throws {@link ManagedPolicyInvalidError}. */
export function decodeManagedPolicy(
  location: string,
  raw: ManagedPolicyRawInput,
): ManagedPolicyDocument {
  let value: unknown;
  if (raw.kind === 'text') {
    // Windows editors commonly write a UTF-8 byte-order mark.
    const text = raw.text.startsWith('\uFEFF') ? raw.text.slice(1) : raw.text;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ManagedPolicyInvalidError(
        location,
        `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // JSON.parse keeps the last of two equal names, so a second `"limits"`
    // would silently erase the first one's restrictions.
    let duplicate: string | null;
    try {
      duplicate = duplicateJsonMemberPath(text);
    } catch (error) {
      // A scanner failure must still refuse with the marker, never escape.
      throw new ManagedPolicyInvalidError(
        location,
        `it cannot be checked for duplicate keys (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (duplicate !== null)
      throw new ManagedPolicyInvalidError(
        location,
        `duplicate key ${duplicate}`,
      );
  } else {
    value = raw.value;
  }
  const parsed = parseManagedPolicyDocument(value);
  if (!parsed.ok)
    throw new ManagedPolicyInvalidError(
      location,
      `it does not match the policy schema (${formatManagedPolicyProblems(parsed.problems)})`,
      parsed.problems,
    );
  return parsed.document;
}

export function managedPolicyDigest(
  document: ManagedPolicyDocument,
): ManagedPolicyDigest {
  return `sha256:${createHash('sha256').update(canonicalManagedPolicyJson(document), 'utf8').digest('hex')}`;
}

export interface LoadedManagedPolicy {
  source: ManagedPolicySourceDescriptor;
  document: ManagedPolicyDocument;
  digest: ManagedPolicyDigest;
  summary: ManagedPolicySummary;
}

/**
 * Load the one policy among `sources`. None present means no policy; more
 * than one present is an error, because Station cannot tell which one the
 * administrator meant and merging them could weaken either.
 */
export function loadManagedPolicyFromSources(
  sources: readonly ManagedPolicySource[],
): LoadedManagedPolicy | null {
  const present: Array<{
    source: ManagedPolicySource;
    raw: ManagedPolicyRawInput;
  }> = [];
  for (const source of sources) {
    const raw = source.read();
    if (raw) present.push({ source, raw });
  }
  if (present.length === 0) return null;
  if (present.length > 1)
    throw new ManagedPolicyInvalidError(
      present.map(({ source }) => source.descriptor.location).join(' and '),
      'more than one policy source is installed; keep exactly one',
    );
  const [{ source, raw }] = present;
  const document = decodeManagedPolicy(source.descriptor.location, raw);
  return {
    source: { ...source.descriptor },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

export interface LoadInstalledManagedPolicyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Replaces {@link systemManagedPolicySources}; unit tests only. */
  systemSources?: readonly ManagedPolicySource[];
}

/**
 * The policy this machine has installed, as the server loads it at startup
 * and as `station policy show` reports it. Throws
 * {@link ManagedPolicyInvalidError} for anything Station cannot enforce.
 */
export function loadInstalledManagedPolicy(
  options: LoadInstalledManagedPolicyOptions = {},
): LoadedManagedPolicy | null {
  const env = options.env ?? process.env;
  const system =
    options.systemSources ?? systemManagedPolicySources(options.platform);
  const override = env[MANAGED_POLICY_TEST_FILE_ENV];
  if (override === undefined || override === '')
    return loadManagedPolicyFromSources(system);

  if (!isAbsolute(override))
    throw new ManagedPolicyInvalidError(
      override,
      `${MANAGED_POLICY_TEST_FILE_ENV} must be an absolute path`,
    );
  // The override may add a policy where none is installed (that only
  // narrows what the user can do) but never stand in for an installed one.
  // Reading every system source first also means an unreadable system policy
  // still fails closed under the override.
  const installed = system.filter((source) => source.read() !== undefined);
  if (installed.length > 0)
    throw new ManagedPolicyInvalidError(
      installed.map((source) => source.descriptor.location).join(' and '),
      `${MANAGED_POLICY_TEST_FILE_ENV} is set, but a system policy is installed and the test override cannot replace it; unset ${MANAGED_POLICY_TEST_FILE_ENV}`,
    );
  const loaded = loadManagedPolicyFromSources([
    managedPolicyFileSource(override, 'test-override'),
  ]);
  if (!loaded)
    throw new ManagedPolicyInvalidError(
      override,
      `${MANAGED_POLICY_TEST_FILE_ENV} names a file that does not exist`,
    );
  return loaded;
}

/** The status a server reports for what it loaded. */
export function managedPolicyStatus(
  loaded: LoadedManagedPolicy | null,
): ManagedPolicyStatus {
  if (!loaded) return { state: 'none' };
  return {
    state: 'loaded',
    source: { ...loaded.source },
    digest: loaded.digest,
    summary: loaded.summary,
  };
}
