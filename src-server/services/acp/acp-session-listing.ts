import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { InitializeResult } from './acp-process.js';

/**
 * ACP `session/list` as read by Station's capability probe, for showing
 * sessions an ACP agent ran outside Station (`AcpSessionListSource`).
 *
 * List only. `session/load` is not used to read history: the protocol defines
 * it as resuming the session inside the answering agent process ("the Client
 * can then continue sending prompts"), and Antigravity 1.5.8 accepted a load
 * for an id its own `session/list` did not report. A load is therefore not a
 * read, so no transcript is imported from an ACP agent.
 */

/** Opt-in: listing makes every probe of a listing agent also enumerate its sessions. */
export const ACP_SESSION_LISTING_ENV = 'STATION_EXTERNAL_ACP_SESSIONS';

export function acpSessionListingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ACP_SESSION_LISTING_ENV] === '1';
}

export const ACP_SESSION_LISTING_BOUNDS = {
  maxPages: 4,
  maxSessions: 256,
  maxIdBytes: 256,
  maxCwdBytes: 4096,
  maxCursorBytes: 1024,
  /** Least time a background probe gives a listing once its budget is spent. */
  minDeadlineMs: 2_000,
} as const;

export interface AcpListedSession {
  sessionId: string;
  cwd: string;
  /** ISO 8601, when the agent reported a parseable last-activity time. */
  updatedAt?: string;
}

export type AcpSessionListingOutcome =
  /** Every page was read. */
  | 'ok'
  /** A page, session or cursor bound stopped the read; what was read is kept. */
  | 'limit'
  /** The agent answered with something that is not a session list. */
  | 'malformed'
  /** The request failed or ran out of time. */
  | 'failed';

export interface AcpSessionListing {
  observedAt: number;
  outcome: AcpSessionListingOutcome;
  sessions: AcpListedSession[];
  /** Entries dropped because a field was missing or out of bounds. */
  rejected: number;
}

/** Whether `initialize` advertised `session/list` (`sessionCapabilities.list`). */
export function advertisesSessionListing(
  agentCapabilities: InitializeResult['agentCapabilities'] | null | undefined,
): boolean {
  const list = (
    agentCapabilities?.sessionCapabilities as { list?: unknown } | undefined
  )?.list;
  return list !== undefined && list !== null;
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value !== value.trim()) return undefined;
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return undefined;
  }
  return value;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

/**
 * One `session/list` result page, or `undefined` when it is not one. Each
 * entry needs a bounded id and an absolute cwd (the protocol requires one);
 * other fields, including the title, are not kept.
 */
export function parseAcpSessionListPage(value: unknown):
  | {
      sessions: AcpListedSession[];
      rejected: number;
      nextCursor?: string;
      cursorRejected: boolean;
      /** More entries than one listing keeps: refused unread. */
      oversized?: true;
    }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const page = value as { sessions?: unknown; nextCursor?: unknown };
  if (!Array.isArray(page.sessions)) return undefined;
  if (page.sessions.length > ACP_SESSION_LISTING_BOUNDS.maxSessions)
    return {
      sessions: [],
      rejected: 0,
      cursorRejected: false,
      oversized: true,
    };
  const sessions: AcpListedSession[] = [];
  let rejected = 0;
  for (const entry of page.sessions) {
    const record =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : undefined;
    const sessionId = boundedString(
      record?.sessionId,
      ACP_SESSION_LISTING_BOUNDS.maxIdBytes,
    );
    const cwd = boundedString(
      record?.cwd,
      ACP_SESSION_LISTING_BOUNDS.maxCwdBytes,
    );
    if (!sessionId || !cwd || !isAbsolute(cwd)) {
      rejected += 1;
      continue;
    }
    const updatedAt = isoTimestamp(record?.updatedAt);
    sessions.push({ sessionId, cwd, ...(updatedAt ? { updatedAt } : {}) });
  }
  const rawCursor = page.nextCursor;
  const nextCursor =
    rawCursor === undefined || rawCursor === null
      ? undefined
      : boundedString(rawCursor, ACP_SESSION_LISTING_BOUNDS.maxCursorBytes);
  return {
    sessions,
    rejected,
    ...(nextCursor ? { nextCursor } : {}),
    cursorRejected:
      rawCursor !== undefined && rawCursor !== null && !nextCursor,
  };
}

/**
 * Read an agent's session list through `request`, paging by `nextCursor`
 * within the bounds above and `deadlineMs`. Sessions named in `exclude`
 * (the probe's own) are left out. Never throws: a failure is an outcome.
 */
export async function readAcpSessionListing(
  request: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
  options: {
    deadlineMs: number;
    /**
     * Floor under `deadlineMs`. Only a background probe sets it: an awaited
     * probe must not outlast its own budget, so with none left it sends nothing.
     */
    minDeadlineMs?: number;
    exclude?: ReadonlySet<string>;
    /** Sessions in a folder this answers true for are left out too. */
    excludeFolder?: (cwd: string) => boolean;
    now?: () => number;
  },
): Promise<AcpSessionListing> {
  const now = options.now ?? Date.now;
  const sessions: AcpListedSession[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let rejected = 0;
  let outcome: AcpSessionListingOutcome = 'ok';
  let cursor: string | undefined;
  const budgetMs = Math.max(options.deadlineMs, options.minDeadlineMs ?? 0);
  if (budgetMs <= 0)
    return { observedAt: now(), outcome: 'failed', sessions, rejected };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), budgetMs);
  });
  try {
    for (let page = 0; ; page += 1) {
      if (page >= ACP_SESSION_LISTING_BOUNDS.maxPages) {
        outcome = 'limit';
        break;
      }
      const answer = await Promise.race([
        request('session/list', cursor ? { cursor } : {}),
        deadline,
      ]);
      if (answer === 'deadline') {
        outcome = 'failed';
        break;
      }
      const parsed = parseAcpSessionListPage(answer);
      if (!parsed) {
        outcome = 'malformed';
        break;
      }
      if (parsed.oversized) {
        outcome = 'limit';
        break;
      }
      rejected += parsed.rejected;
      let full = false;
      for (const session of parsed.sessions) {
        if (options.exclude?.has(session.sessionId)) continue;
        if (options.excludeFolder?.(session.cwd)) continue;
        if (seen.has(session.sessionId)) continue;
        if (sessions.length >= ACP_SESSION_LISTING_BOUNDS.maxSessions) {
          full = true;
          break;
        }
        seen.add(session.sessionId);
        sessions.push(session);
      }
      if (full || parsed.cursorRejected) {
        outcome = 'limit';
        break;
      }
      if (!parsed.nextCursor) break;
      // A cursor the agent already handed out would page forever.
      if (cursors.has(parsed.nextCursor)) {
        outcome = 'malformed';
        break;
      }
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
  } catch {
    outcome = 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { observedAt: now(), outcome, sessions, rejected };
}

/**
 * Engines whose external sessions another source already imports from their
 * own store (`GrokSessionSource`, `OpenCodeSessionSource`). Listing them here
 * too would show each of their sessions twice.
 */
const DEDICATED_SOURCE_COMMANDS = new Set(['grok', 'opencode']);
const DEDICATED_SOURCE_CONNECTION_IDS = new Set(['grok-build', 'opencode']);

export function hasDedicatedSessionSource(connection: {
  id: string;
  command: string;
}): boolean {
  const executable = basename(connection.command).replace(/\.(exe|cmd)$/i, '');
  return (
    DEDICATED_SOURCE_CONNECTION_IDS.has(connection.id) ||
    DEDICATED_SOURCE_COMMANDS.has(executable)
  );
}

/** At most this many probe session ids are remembered per connection. */
export const MAX_REMEMBERED_PROBE_SESSIONS = 256;
/** One cap for both sides: the writer trims to it, the reader refuses past it. */
export const PROBE_SESSION_LEDGER_MAX_BYTES = 64 * 1024;

/**
 * Where a connection's probe session ids are remembered across Station
 * restarts: a private file under Station home, named by a digest of the
 * connection id, never inside a folder the agent works in.
 */
export function probeSessionLedgerPath(
  stationHome: string,
  connectionId: string,
): string {
  const name = createHash('sha256').update(connectionId).digest('hex');
  return join(stationHome, 'runtime', 'acp-probe-sessions', `${name}.json`);
}

/** The remembered ids, oldest first; a missing or unreadable file is none. */
export function readProbeSessionIds(path: string): string[] {
  try {
    if (statSync(path).size > PROBE_SESSION_LEDGER_MAX_BYTES) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (id): id is string =>
          boundedString(id, ACP_SESSION_LISTING_BOUNDS.maxIdBytes) !==
          undefined,
      )
      .slice(-MAX_REMEMBERED_PROBE_SESSIONS);
  } catch {
    return [];
  }
}

/**
 * Replaces the remembered ids atomically. Keeps the newest ids that fit
 * {@link PROBE_SESSION_LEDGER_MAX_BYTES}, dropping the oldest, so the reader
 * never discards the whole file for size. The folder is made owner-only even
 * when it existed, and the temporary file is created exclusively without
 * following a link.
 */
export function writeProbeSessionIds(
  path: string,
  ids: readonly string[],
): void {
  let kept = ids.slice(-MAX_REMEMBERED_PROBE_SESSIONS);
  let content = JSON.stringify(kept);
  while (
    kept.length > 0 &&
    Buffer.byteLength(content, 'utf8') > PROBE_SESSION_LEDGER_MAX_BYTES
  ) {
    kept = kept.slice(1);
    content = JSON.stringify(kept);
  }
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    try {
      writeSync(descriptor, content);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** A folder compared as given and as its real path, for agents that report either. */
export function sameFolder(left: string, right: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return left === right || real(left) === real(right);
}
