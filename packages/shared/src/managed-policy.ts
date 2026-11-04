/**
 * Reading the managed policy (#4515) from where an administrator installs it.
 *
 * The document shape, its parser and the client summary live in
 * `@kontourai/station-contracts/managed-policy`. This module owns the Node
 * side: the fixed per-OS file path, the source abstraction later sources
 * (a macOS configuration profile, the Windows registry) plug into, the test
 * override, the fingerprint, and the one error every failure becomes.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  canonicalManagedPolicyJson,
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

export class ManagedPolicyInvalidError extends Error {
  readonly code = MANAGED_POLICY_INVALID_MARKER;

  constructor(
    /** The source location(s) at fault, for the administrator. */
    readonly location: string,
    readonly reason: string,
    readonly problems: readonly ManagedPolicyProblem[] = [],
  ) {
    super(
      `${MANAGED_POLICY_INVALID_MARKER}: Station cannot use the managed policy at ${location}: ${reason}. Station will not start until an administrator fixes or removes it.`,
    );
    this.name = 'ManagedPolicyInvalidError';
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

/** Read a policy file; only a missing path means "no policy". */
export function readManagedPolicyFile(
  path: string,
): ManagedPolicyRawInput | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw new ManagedPolicyInvalidError(path, unreadableReason(error));
  }
  try {
    let size: number;
    try {
      const stats = fstatSync(fd);
      if (stats.isDirectory())
        throw new ManagedPolicyInvalidError(
          path,
          'it is a directory, not a file',
        );
      if (!stats.isFile())
        throw new ManagedPolicyInvalidError(path, 'it is not a regular file');
      size = stats.size;
    } catch (error) {
      if (error instanceof ManagedPolicyInvalidError) throw error;
      throw new ManagedPolicyInvalidError(path, unreadableReason(error));
    }
    if (size > MANAGED_POLICY_MAX_BYTES)
      throw new ManagedPolicyInvalidError(
        path,
        `the file is larger than ${MANAGED_POLICY_MAX_BYTES} bytes`,
      );
    // Read one byte past the limit so a file that grew after fstat is
    // refused rather than silently truncated.
    const buffer = Buffer.alloc(MANAGED_POLICY_MAX_BYTES + 1);
    let length = 0;
    try {
      for (;;) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
        if (length > MANAGED_POLICY_MAX_BYTES)
          throw new ManagedPolicyInvalidError(
            path,
            `the file is larger than ${MANAGED_POLICY_MAX_BYTES} bytes`,
          );
      }
    } catch (error) {
      if (error instanceof ManagedPolicyInvalidError) throw error;
      throw new ManagedPolicyInvalidError(path, unreadableReason(error));
    }
    return { kind: 'text', text: buffer.subarray(0, length).toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

export function managedPolicyFileSource(
  path: string,
  kind: ManagedPolicySourceDescriptor['kind'] = 'file',
): ManagedPolicySource {
  return {
    descriptor: { kind, location: path },
    read: () => readManagedPolicyFile(path),
  };
}

/**
 * Every system source on `platform`, in a stable order. Later slices add the
 * macOS configuration profile and the Windows registry here.
 */
export function systemManagedPolicySources(
  platform: NodeJS.Platform = process.platform,
): ManagedPolicySource[] {
  return [managedPolicyFileSource(managedPolicyFilePath(platform))];
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
