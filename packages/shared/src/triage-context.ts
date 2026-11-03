/**
 * One implementation of Station's triage context rules, shared by the
 * `station triage` CLI and the server's in-app troubleshoot prepare route.
 *
 * It owns the owner-only run directory under `$STATION_ROOT/cache/triage`,
 * the allowlisted doctor/build/log summaries, the per-field and whole-payload
 * bounds, and the exact-key schema validators for both context shapes. Every
 * persisted value passes through the shared redactor first; redaction is
 * pattern-based, so a reviewer must still read an artifact before sharing it.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildTroubleshootIssueFormUrl,
  TROUBLESHOOT_REPORT_FIELD_IDS,
  type TroubleshootIssueFormLink,
  TroubleshootReportBoundsError,
  type TroubleshootReportFields,
} from '@kontourai/station-contracts/troubleshoot';
import { redactDeep, redactSecrets, sanitizeFreeText } from './redaction.js';
import {
  resolveRuntimeHome,
  resolveStationRoot,
} from './runtime-path-resolver.js';
import {
  assertWindowsPathsTrusted,
  ensureWindowsDirectoriesTrusted,
  runWindowsTrustCommand,
} from './windows-path-trust.js';

export const TRIAGE_CONTEXT_SCHEMA_VERSION = 2;
export const MAX_TRIAGE_CONTEXT_BYTES = 96 * 1024;
export const MAX_TRIAGE_DOCTOR_CHECKS = 32;
export const MAX_TRIAGE_TEXT_LENGTH = 1_024;
export const MAX_TRIAGE_LOG_TAIL_LENGTH = 4_096;
export const MAX_TRIAGE_REMOTE_RESPONSE_BYTES = 512 * 1024;

/** In-app seed context limits. Longer input is refused, never truncated. */
export const MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH = 512;
export const MAX_TROUBLESHOOT_SEED_ERROR_LENGTH = 2_000;

const TRIAGE_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── owner-only run storage ─────────────────────────────────────────────────

function assertOwnerDirectory(path: string, ownerOnly: boolean): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Triage storage must be a real directory: ${path}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`Triage storage is not owned by this user: ${path}`);
  }
  if (typeof process.getuid === 'function' && (info.mode & 0o022) !== 0) {
    throw new Error(`Triage storage is writable by group or others: ${path}`);
  }
  if (ownerOnly) chmodSync(path, 0o700);
  assertWindowsPathsTrusted(runWindowsTrustCommand, [
    { kind: 'directory', path },
  ]);
}

function admitStationRoot(path: string): string {
  // The shared root contract allows an explicit whole-root alias. Create a
  // missing nested root, then canonicalize it before inspecting cache leaves.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  ensureWindowsDirectoriesTrusted(runWindowsTrustCommand, [path]);
  const root = realpathSync(path);
  assertOwnerDirectory(root, false);
  return root;
}

function createExactDirectory(path: string, ownerOnly: boolean): void {
  try {
    mkdirSync(path, { mode: ownerOnly ? 0o700 : 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  ensureWindowsDirectoriesTrusted(runWindowsTrustCommand, [path]);
  // Cache/triage must be exact leaves: never allow a symlink to redirect a
  // run after the whole-root alias has been admitted above.
  assertOwnerDirectory(path, ownerOnly);
}

/** Whether `value` is a run id a triage run directory may be named after. */
export function isTriageRunId(value: string): boolean {
  return TRIAGE_RUN_ID_PATTERN.test(value);
}

/**
 * Creates an opaque owner-only run below the one app-owned Station root.
 * `stationRoot` defaults to the process's resolved `$STATION_ROOT`.
 */
export function createTriageRunDirectory(
  runId: string = randomUUID(),
  stationRoot: string = resolveStationRoot(),
): string {
  if (!isTriageRunId(runId)) {
    throw new Error('Triage run ids must be UUIDs.');
  }
  const root = admitStationRoot(stationRoot);
  // Verify every existing boundary separately: recursive mkdir can otherwise
  // follow a pre-existing cache symlink outside Station ownership.
  const cacheRoot = join(root, 'cache');
  createExactDirectory(cacheRoot, false);
  const triageRoot = join(cacheRoot, 'triage');
  createExactDirectory(triageRoot, true);
  const runDir = join(triageRoot, runId);
  if (existsSync(runDir))
    throw new Error('Refusing to reuse an existing triage run.');
  mkdirSync(runDir, { mode: 0o700 });
  assertOwnerDirectory(runDir, true);
  return runDir;
}

/** Writes a new owner-only (0600) artifact; refuses to replace an existing file. */
export function writeTriageOwnerFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Rewrites an owner-controlled regular artifact without following a swap. */
export function rewriteTriageOwnerFile(path: string, contents: string): void {
  const initial = lstatSync(path);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    (typeof process.getuid === 'function' && initial.uid !== process.getuid())
  ) {
    throw new Error(
      `Triage artifact is not an owner-controlled regular file: ${path}`,
    );
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      (typeof process.getuid === 'function' && opened.uid !== process.getuid())
    ) {
      throw new Error(`Triage artifact changed before rewrite: ${path}`);
    }
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── bounded, redacted summaries ────────────────────────────────────────────

export interface TriageDoctorReport {
  checks?: Array<{ label?: unknown; status?: unknown; detail?: unknown }>;
  recommendation?: unknown;
  chatReady?: unknown;
  runtimeReady?: unknown;
}

export interface TriageDoctorSummary {
  checks: Array<{ label: string; status: string; detail: string }>;
  recommendation: string;
  chatReady: boolean | null;
  runtimeReady: boolean | null;
}

export type TriageDoctorFacts =
  | { status: 'available'; report: TriageDoctorSummary }
  | { status: 'unavailable'; reason: string };

/** A free-text field after secret, URL and absolute-path removal and the field cap. */
export function boundedTriageText(value: unknown): string {
  return sanitizeFreeText(String(value ?? ''), MAX_TRIAGE_TEXT_LENGTH);
}

export function summarizeTriageDoctor(
  report: TriageDoctorReport,
): TriageDoctorSummary {
  const redacted = redactDeep(report);
  const checks = Array.isArray(redacted.checks) ? redacted.checks : [];
  return {
    checks: checks.slice(0, MAX_TRIAGE_DOCTOR_CHECKS).map((check) => ({
      label: boundedTriageText(check?.label),
      status: boundedTriageText(check?.status),
      detail: boundedTriageText(check?.detail),
    })),
    recommendation: boundedTriageText(redacted.recommendation),
    chatReady:
      typeof redacted.chatReady === 'boolean' ? redacted.chatReady : null,
    runtimeReady:
      typeof redacted.runtimeReady === 'boolean' ? redacted.runtimeReady : null,
  };
}

/** The newest end of a sanitized log tail, marked when older lines were dropped. */
export function boundedTriageLogTail(value: unknown): string {
  const raw = String(value ?? '');
  const sanitized = sanitizeFreeText(raw, Math.max(raw.length + 1, 1));
  if (sanitized.length <= MAX_TRIAGE_LOG_TAIL_LENGTH) return sanitized;
  const marker = '…[TRUNCATED]\n';
  // Leave headroom for the final context-wide redaction pass.
  const persistedLimit = MAX_TRIAGE_LOG_TAIL_LENGTH - 32;
  return `${marker}${sanitized.slice(-(persistedLimit - marker.length))}`;
}

const BUILD_KEYS = ['version', 'channel', 'sourceSha', 'builtAt'] as const;

/** Only the version/channel/source/built-at build facts, bounded and redacted. */
export function allowlistedTriageBuild(
  value: unknown,
): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = redactDeep(value as Record<string, unknown>);
  const result: Record<string, string> = {};
  for (const key of BUILD_KEYS) {
    if (typeof input[key] === 'string')
      result[key] = boundedTriageText(input[key]);
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Parses a JSON response, refusing a body larger than the remote byte limit. */
export async function readBoundedTriageJson(
  response: Response,
): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_TRIAGE_REMOTE_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Diagnostics response exceeded its byte limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Diagnostics response had no body.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_TRIAGE_REMOTE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Diagnostics response exceeded its byte limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

/**
 * The persisted JSON for a validated context: one more deep redaction pass,
 * then the whole-payload byte cap. Over the cap throws; nothing is truncated.
 */
export function serializeTriageContext(context: unknown): string {
  const serialized = `${JSON.stringify(redactDeep(context), null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TRIAGE_CONTEXT_BYTES) {
    throw new Error(
      'Triage context exceeded its byte limit. No context was persisted.',
    );
  }
  return serialized;
}

// ── schema validation ──────────────────────────────────────────────────────

function hasExactKeys(record: object, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validDoctorSummary(summary: TriageDoctorSummary): boolean {
  return (
    hasExactKeys(summary, [
      'checks',
      'recommendation',
      'chatReady',
      'runtimeReady',
    ]) &&
    Array.isArray(summary.checks) &&
    summary.checks.length <= MAX_TRIAGE_DOCTOR_CHECKS &&
    summary.checks.every((check) =>
      hasExactKeys(check, ['label', 'status', 'detail']),
    )
  );
}

function validDoctorFacts(doctor: TriageDoctorFacts): boolean {
  if (doctor.status === 'available')
    return (
      hasExactKeys(doctor, ['status', 'report']) &&
      validDoctorSummary(doctor.report)
    );
  return (
    doctor.status === 'unavailable' &&
    hasExactKeys(doctor, ['status', 'reason']) &&
    typeof doctor.reason === 'string'
  );
}

export type TriageAgent = 'codex' | 'claude';
export type TriageAgentAvailability =
  | 'available'
  | 'unavailable'
  | 'not-probed';

/**
 * Where this machine's Station runtime keeps its logs, for an agent working
 * in a terminal. The directory is shown with the home directory as `~`; a
 * directory outside the home directory is withheld (`null`) rather than
 * persisted as a raw absolute path.
 */
export interface TriageLocalLogs {
  directory: string | null;
  status: 'present' | 'absent';
}

/**
 * The local runtime home's log directory (the durable server log store is its
 * `server/` subdirectory). This is the default runtime for the caller's
 * environment, which is not necessarily the Station the run targets.
 */
export function localTriageLogFacts(runtimeHome?: string): TriageLocalLogs {
  let home: string;
  try {
    home = runtimeHome ?? resolveRuntimeHome();
  } catch {
    return { directory: null, status: 'absent' };
  }
  const directory = join(home, 'logs');
  const shown = redactTroubleshootReportText(directory);
  return {
    directory:
      shown.startsWith('~') && shown.length <= MAX_TRIAGE_TEXT_LENGTH
        ? shown
        : null,
    status: existsSync(directory) ? 'present' : 'absent',
  };
}

/** The `station triage` CLI's context.json, schema v2. */
export interface TriageContext {
  schemaVersion: 2;
  generatedAt: string;
  runId: string;
  cli: {
    distribution: 'source' | 'packaged';
    version: string;
    channel: string;
    sourceRevision: string;
    artifactBuiltAt: string | null;
  };
  target: {
    station: string | null;
    resolutionSource: string;
    endpoint: string;
    environmentId: string | null;
    access: 'not-configured' | 'available' | 'missing' | 'unavailable';
    hasLocalServiceBinding: boolean;
  };
  capabilities: {
    localHostFilesystem: 'available' | 'unavailable';
    sourceDoctor: 'available' | 'unavailable';
    remoteReadFacts: 'available' | 'unavailable';
    recentLogs: 'available' | 'unavailable';
  };
  doctor: TriageDoctorFacts;
  agents: Record<TriageAgent, TriageAgentAvailability>;
  remote:
    | {
        status: 'available';
        app: {
          version: string;
          nodeVersion: string;
          platform: string;
          build: Record<string, string> | null;
        };
        doctor: TriageDoctorSummary;
        logs:
          | { status: 'available'; tail: string }
          | { status: 'unavailable'; reason: string };
      }
    | { status: 'unavailable'; reason: string };
  localLogs: TriageLocalLogs;
  launch: {
    requested: TriageAgent | null;
    selected: TriageAgent | null;
    status:
      | 'context-only'
      | 'not-installed'
      | 'ambiguous'
      | 'pending'
      | 'completed'
      | 'failed';
    exitCode: number | null;
  };
  limits: {
    contextBytes: number;
    doctorChecks: number;
    textLength: number;
  };
}

/** Refuses any CLI context outside schema v2's exact keys and bounded values. */
export function validateTriageContext(value: TriageContext): void {
  const allowed = [
    'schemaVersion',
    'generatedAt',
    'runId',
    'cli',
    'target',
    'capabilities',
    'doctor',
    'agents',
    'remote',
    'localLogs',
    'launch',
    'limits',
  ];
  if (
    value.schemaVersion !== TRIAGE_CONTEXT_SCHEMA_VERSION ||
    !hasExactKeys(value, allowed) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.generatedAt) ||
    !/^[0-9a-f-]{36}$/i.test(value.runId)
  ) {
    throw new Error(
      `Triage context did not satisfy schema v${TRIAGE_CONTEXT_SCHEMA_VERSION}.`,
    );
  }
  if (!['source', 'packaged'].includes(value.cli.distribution)) {
    throw new Error('Triage context has an invalid distribution identity.');
  }
  if (
    !hasExactKeys(value.cli, [
      'distribution',
      'version',
      'channel',
      'sourceRevision',
      'artifactBuiltAt',
    ]) ||
    !hasExactKeys(value.target, [
      'station',
      'resolutionSource',
      'endpoint',
      'environmentId',
      'access',
      'hasLocalServiceBinding',
    ]) ||
    !hasExactKeys(value.capabilities, [
      'localHostFilesystem',
      'sourceDoctor',
      'remoteReadFacts',
      'recentLogs',
    ]) ||
    !hasExactKeys(value.agents, ['codex', 'claude']) ||
    (value.remote.status === 'available' &&
      (!hasExactKeys(value.remote, ['status', 'app', 'doctor', 'logs']) ||
        !hasExactKeys(value.remote.app, [
          'version',
          'nodeVersion',
          'platform',
          'build',
        ]) ||
        !validDoctorSummary(value.remote.doctor) ||
        (value.remote.logs.status === 'available' &&
          !hasExactKeys(value.remote.logs, ['status', 'tail'])) ||
        (value.remote.logs.status === 'unavailable' &&
          !hasExactKeys(value.remote.logs, ['status', 'reason'])))) ||
    (value.remote.status === 'unavailable' &&
      !hasExactKeys(value.remote, ['status', 'reason'])) ||
    !hasExactKeys(value.localLogs, ['directory', 'status']) ||
    !hasExactKeys(value.launch, [
      'requested',
      'selected',
      'status',
      'exitCode',
    ]) ||
    !hasExactKeys(value.limits, ['contextBytes', 'doctorChecks', 'textLength'])
  ) {
    throw new Error(
      `Triage context contains fields outside schema v${TRIAGE_CONTEXT_SCHEMA_VERSION}.`,
    );
  }
  if (
    !['available', 'unavailable'].includes(
      value.capabilities.localHostFilesystem,
    )
  ) {
    throw new Error('Triage context has invalid capability facts.');
  }
  if (
    !['available', 'unavailable'].includes(value.capabilities.sourceDoctor) ||
    !['available', 'unavailable'].includes(value.doctor.status) ||
    !['available', 'unavailable'].includes(value.remote.status) ||
    !['available', 'unavailable'].includes(
      value.capabilities.remoteReadFacts,
    ) ||
    !['available', 'unavailable'].includes(value.capabilities.recentLogs) ||
    !['present', 'absent'].includes(value.localLogs.status) ||
    // Only a home-relative location may be persisted; never a raw path.
    (value.localLogs.directory !== null &&
      (typeof value.localLogs.directory !== 'string' ||
        !value.localLogs.directory.startsWith('~') ||
        value.localLogs.directory.length > MAX_TRIAGE_TEXT_LENGTH)) ||
    !['available', 'unavailable', 'not-probed'].includes(value.agents.codex) ||
    !['available', 'unavailable', 'not-probed'].includes(value.agents.claude) ||
    ![
      'context-only',
      'not-installed',
      'ambiguous',
      'pending',
      'completed',
      'failed',
    ].includes(value.launch.status) ||
    value.limits.contextBytes !== MAX_TRIAGE_CONTEXT_BYTES ||
    value.limits.doctorChecks !== MAX_TRIAGE_DOCTOR_CHECKS ||
    value.limits.textLength !== MAX_TRIAGE_TEXT_LENGTH
  ) {
    throw new Error('Triage context has invalid bounded values.');
  }
  if (
    value.remote.status === 'available' &&
    (!['available', 'unavailable'].includes(value.remote.logs.status) ||
      (value.remote.app.build !== null &&
        Object.keys(value.remote.app.build).some(
          (key) => !(BUILD_KEYS as readonly string[]).includes(key),
        )))
  ) {
    throw new Error('Triage context has invalid remote diagnostics.');
  }
  if (value.doctor.status === 'available' && !validDoctorFacts(value.doctor)) {
    throw new Error('Triage context exceeded its doctor check limit.');
  }
  if (
    value.doctor.status === 'unavailable' &&
    !validDoctorFacts(value.doctor)
  ) {
    throw new Error('Triage context has an invalid doctor result.');
  }
}

// ── in-app troubleshoot context ────────────────────────────────────────────

export const TROUBLESHOOT_CONTEXT_SCHEMA = 'station-troubleshoot-context';
export type TroubleshootCallerRole = 'owner' | 'member';
export type TroubleshootContextSurface =
  | 'desktop'
  | 'web'
  | 'mobile'
  | 'unknown';

/** The in-app troubleshoot run's context.json, schema v1. */
export interface TroubleshootContext {
  schema: typeof TROUBLESHOOT_CONTEXT_SCHEMA;
  schemaVersion: 1;
  generatedAt: string;
  runId: string;
  station: {
    name: string;
    environmentId: string | null;
    version: string;
    channel: string;
    sourceRevision: string | null;
    builtAt: string | null;
    platform: string;
    nodeVersion: string;
  };
  caller: {
    role: TroubleshootCallerRole;
    surface: TroubleshootContextSurface;
  };
  doctor: TriageDoctorFacts;
  logs: {
    serverLogStore: 'available' | 'unavailable';
    agentRead: 'requires-operator-grant';
  };
  /** `route` is the in-app path without its leading "/". */
  seed: { route: string | null; errorSummary: string | null };
  limits: {
    contextBytes: number;
    doctorChecks: number;
    textLength: number;
  };
}

export type TroubleshootSeedRefusal =
  | 'route-too-long'
  | 'route-not-in-app'
  | 'error-summary-too-long';

export class TroubleshootSeedError extends Error {
  constructor(
    readonly reason: TroubleshootSeedRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'TroubleshootSeedError';
  }
}

/**
 * Admits optional seed context. An over-limit value is refused with
 * {@link TroubleshootSeedError}; nothing is truncated. A route keeps only its
 * in-app path: a scheme, host, query or fragment can carry a credential.
 */
export function admitTroubleshootSeed(input: {
  route?: string | null;
  errorSummary?: string | null;
}): TroubleshootContext['seed'] {
  const route = input.route ?? null;
  const errorSummary = input.errorSummary ?? null;
  if (route !== null) {
    if (route.length > MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH)
      throw new TroubleshootSeedError(
        'route-too-long',
        `Seed route exceeds ${MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH} characters.`,
      );
    if (!route.startsWith('/') || route.startsWith('//'))
      throw new TroubleshootSeedError(
        'route-not-in-app',
        'Seed route must be an in-app path starting with a single "/".',
      );
  }
  if (
    errorSummary !== null &&
    errorSummary.length > MAX_TROUBLESHOOT_SEED_ERROR_LENGTH
  )
    throw new TroubleshootSeedError(
      'error-summary-too-long',
      `Seed error summary exceeds ${MAX_TROUBLESHOOT_SEED_ERROR_LENGTH} characters.`,
    );
  // Stored relative to the app root (no leading "/", so the root route is
  // ""): the persistence pass's free-text sanitizer removes anything shaped
  // like an absolute filesystem path, which an in-app route resembles. The
  // report redactor still removes credentials and home directories.
  const path = route?.split(/[?#]/, 1)[0] ?? null;
  return {
    route: path === null ? null : redactTroubleshootReportText(path.slice(1)),
    errorSummary: errorSummary?.trim()
      ? sanitizeFreeText(errorSummary, MAX_TRIAGE_TEXT_LENGTH * 2)
      : null,
  };
}

/** Refuses any in-app context outside schema v1's exact keys and bounded values. */
export function validateTroubleshootContext(value: TroubleshootContext): void {
  if (
    value.schema !== TROUBLESHOOT_CONTEXT_SCHEMA ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, [
      'schema',
      'schemaVersion',
      'generatedAt',
      'runId',
      'station',
      'caller',
      'doctor',
      'logs',
      'seed',
      'limits',
    ]) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.generatedAt) ||
    !isTriageRunId(value.runId)
  ) {
    throw new Error('Troubleshoot context did not satisfy schema v1.');
  }
  if (
    !hasExactKeys(value.station, [
      'name',
      'environmentId',
      'version',
      'channel',
      'sourceRevision',
      'builtAt',
      'platform',
      'nodeVersion',
    ]) ||
    !hasExactKeys(value.caller, ['role', 'surface']) ||
    !hasExactKeys(value.logs, ['serverLogStore', 'agentRead']) ||
    !hasExactKeys(value.seed, ['route', 'errorSummary']) ||
    !hasExactKeys(value.limits, ['contextBytes', 'doctorChecks', 'textLength'])
  ) {
    throw new Error('Troubleshoot context contains fields outside schema v1.');
  }
  const stationText = Object.values(value.station).every(
    (field) =>
      field === null ||
      (typeof field === 'string' && field.length <= MAX_TRIAGE_TEXT_LENGTH),
  );
  if (
    !stationText ||
    !['owner', 'member'].includes(value.caller.role) ||
    !['desktop', 'web', 'mobile', 'unknown'].includes(value.caller.surface) ||
    !['available', 'unavailable'].includes(value.logs.serverLogStore) ||
    value.logs.agentRead !== 'requires-operator-grant' ||
    !validDoctorFacts(value.doctor) ||
    (value.seed.route !== null &&
      value.seed.route.length > MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH) ||
    (value.seed.errorSummary !== null &&
      value.seed.errorSummary.length > MAX_TRIAGE_TEXT_LENGTH * 2) ||
    value.limits.contextBytes !== MAX_TRIAGE_CONTEXT_BYTES ||
    value.limits.doctorChecks !== MAX_TRIAGE_DOCTOR_CHECKS ||
    value.limits.textLength !== MAX_TRIAGE_TEXT_LENGTH
  ) {
    throw new Error('Troubleshoot context has invalid bounded values.');
  }
}

// ── issue-report redaction ─────────────────────────────────────────────────

const REDACTED = '[REDACTED]';
const REDACTED_URL = '[REDACTED_URL]';
// A URL runs to the next whitespace. Its core ends at the first `)` or `]`,
// because what follows is either more URL text (`?title=a)secret`) or Markdown
// and prose, and the two cannot be told apart.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"'`]+/gi;
const URL_CORE_END = /[)\]]/;
// Punctuation that may follow a URL core and carries no content of its own.
const DELIMITER_RUN = /^[)\].,;:!?]*/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
// Path segments kept from a public URL. The path is cut at the first segment
// with anything else (percent-encoding, `:`, `(`), which could carry text the
// reviewer did not mean to publish.
const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;
// The only locations a public bug report may keep: Station's own public
// repository and docs site. Any other GitHub path can name a private
// repository or issue, so it is replaced like a LAN, tailnet, or pairing URL.
const PUBLIC_GITHUB_REPOSITORIES = new Set(['kontourai/station']);
const PUBLIC_DOCS_SITE = {
  host: 'kontourai.github.io',
  firstSegment: 'station',
};

/**
 * Rebuilds a public URL from its origin and plain leading path segments, or
 * returns null. Parsing (not prefix matching) means `station/../other/repo`
 * resolves to the other repository; rebuilding drops queries and fragments,
 * which can carry any other URL.
 */
function publicReportUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const segments: string[] = [];
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    if (!PLAIN_SEGMENT.test(segment)) break;
    segments.push(segment);
  }
  const host = url.hostname.toLowerCase();
  const kept = `${url.origin}/${segments.join('/')}`.replace(/\/$/, '');
  if (host === 'github.com') {
    const [owner, repo] = segments;
    if (!owner || !repo) return null;
    const name = `${owner}/${repo.replace(/\.git$/i, '')}`.toLowerCase();
    return PUBLIC_GITHUB_REPOSITORIES.has(name) ? kept : null;
  }
  if (
    host === PUBLIC_DOCS_SITE.host &&
    segments[0]?.toLowerCase() === PUBLIC_DOCS_SITE.firstSegment
  ) {
    return kept;
  }
  return null;
}

function redactReportUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    const coreEnd = match.search(URL_CORE_END);
    const bracketed = coreEnd === -1 ? match : match.slice(0, coreEnd);
    // Sentence punctuation after a URL (`…/4470, and`) belongs to the prose.
    const core = bracketed.replace(TRAILING_PUNCTUATION, '');
    const rest = match.slice(core.length);
    const delimiters = DELIMITER_RUN.exec(rest)?.[0] ?? '';
    // Anything after the delimiters may be URL text; mark it rather than keep it.
    const dropped = rest.length > delimiters.length ? REDACTED : '';
    return (publicReportUrl(core) ?? REDACTED_URL) + delimiters + dropped;
  });
}

// SSH-style Git remotes (`git@github.com:owner/repo.git`) have no scheme, so
// the URL pattern never sees them. Only Station's own remote is kept.
// The user part may only start where a run of user characters starts, so a
// long `a.a.a…` run is scanned once, not once per position. It is not length
// bounded: a bound would let a remote with a long user name skip redaction.
// The host may be a bracketed IPv6 literal.
const SCP_REMOTE_PATTERN =
  /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+@(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.-]{1,253}):[^\s<>"'`]+/g;
const STATION_SCP_REMOTE = /^git@github\.com:kontourai\/station(?:\.git)?$/i;

function redactScpRemotes(text: string): string {
  return text.replace(SCP_REMOTE_PATTERN, (match) => {
    const core = match.replace(TRAILING_PUNCTUATION, '');
    return STATION_SCP_REMOTE.test(core)
      ? match
      : REDACTED_URL + match.slice(core.length);
  });
}
// Station's pairing and device credentials are 32 random bytes in base64url
// (43 characters). Requiring upper, lower and digit keeps commit SHAs, UUIDs
// and kebab-case identifiers readable.
const OPAQUE_CREDENTIAL_PATTERN =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const HOME_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/(?:Users|home)\/[^/\s"'`]+/g,
  /\/root(?=\/|\b)/g,
  /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"'`]+/gi,
];

/**
 * Redaction for text that may leave the machine in an issue report: known
 * credential shapes, opaque Station credentials, non-public URLs, and home
 * directories (shown as `~`). Unlike {@link sanitizeFreeText}, ordinary
 * relative and system paths survive, because a reproducible report needs
 * them. Pattern-based: a reviewer still reads the result before posting.
 */
export function redactTroubleshootReportText(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('troubleshoot report redaction requires a string');
  }
  let result = redactScpRemotes(redactReportUrls(redactSecrets(text)));
  result = result.replace(OPAQUE_CREDENTIAL_PATTERN, REDACTED);
  for (const pattern of HOME_PATH_PATTERNS)
    result = result.replace(pattern, '~');
  return result;
}

export interface TroubleshootReportDraft extends TroubleshootIssueFormLink {
  readonly title: string;
  readonly fields: TroubleshootReportFields;
}

/**
 * Redacts a report's title and fields, then builds its prefilled issue-form
 * link. The in-app drafting tool and `station triage draft-report` both call
 * this, so the two surfaces produce the same text and link. An unknown field
 * id or an over-limit value throws {@link TroubleshootReportBoundsError}.
 */
export function draftTroubleshootReport(input: {
  readonly title: string;
  readonly fields: TroubleshootReportFields;
}): TroubleshootReportDraft {
  for (const id of Object.keys(input.fields)) {
    if (!(TROUBLESHOOT_REPORT_FIELD_IDS as readonly string[]).includes(id))
      throw new TroubleshootReportBoundsError(`Unknown report field: ${id}.`);
  }
  const title = redactTroubleshootReportText(input.title);
  const fields: TroubleshootReportFields = {};
  for (const id of TROUBLESHOOT_REPORT_FIELD_IDS) {
    const value = input.fields[id];
    if (value !== undefined) fields[id] = redactTroubleshootReportText(value);
  }
  return { title, fields, ...buildTroubleshootIssueFormUrl({ title, fields }) };
}
