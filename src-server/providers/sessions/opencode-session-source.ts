import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { isRecord } from '../../utils/is-record.js';
import { createLogger } from '../../utils/logger.js';
import { PARAGRAPH_BREAK } from '../adapters/paragraph-boundary.js';
import {
  boundedPrompt,
  projectBoundedToolOutput,
  truncateJsonString,
  utf8Chunks,
} from '../tool-output-projection.js';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
  AttachedSessionDiscoveryResult,
  AttachedSessionReadResult,
  AttachedSessionSource,
  AttachedSessionSourceOutcome,
} from './attached-session-source.js';
import {
  deriveConfigHomeAffinity,
  resolveConfigHomeAffinity,
} from './transcript-file-io.js';

const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_MESSAGES = 128;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ROW_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_MAX_PARTS_PER_MESSAGE = 1024;
const DEFAULT_READ_YIELD_EVERY_MESSAGES = 16;
const MAX_CANDIDATES_CEILING = 512;
const MAX_MESSAGES_CEILING = 512;
const MAX_BYTES_CEILING = 2 * 1024 * 1024;
const MAX_ROW_BYTES_CEILING = 1024 * 1024;
const MAX_EVENTS_CEILING = 512;
const MAX_PARTS_PER_MESSAGE_CEILING = 4096;
/** Channel databases (`opencode.db`, `opencode-<channel>.db`) per data home. */
const MAX_DATABASE_FILES = 8;
const MAX_ID_BYTES = 192;
const MAX_PATH_BYTES = 4096;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_TEXT_CHUNK_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_TEXT_BYTES = 4096;
const BUSY_TIMEOUT_MS = 250;
const EPOCH = '1970-01-01T00:00:00.000Z';
const SOURCE_HOME_NAMESPACE = 'opencode-data-home';
const PROMPT_SOURCE = 'opencode-session';
const DATABASE_FILE_PATTERN = /^opencode(?:-[A-Za-z0-9._-]{1,64})?\.db$/u;

/**
 * The only tables this source reads, and the columns it depends on. Message
 * and part rows are the transcript whose JSON this source interprets, so
 * their column sets are pinned exactly: an added column there means the
 * writer changed shape and this source fails closed. The session table gains
 * columns in ordinary OpenCode releases (usage, workspace, metadata) that this
 * source never reads, so only the identity columns it uses are required.
 */
const REQUIRED_SESSION_COLUMNS = [
  'id',
  'parent_id',
  'directory',
  'time_created',
  'time_updated',
  'time_archived',
] as const;
const EXACT_MESSAGE_COLUMNS = [
  'id',
  'session_id',
  'time_created',
  'time_updated',
  'data',
] as const;
const EXACT_PART_COLUMNS = [
  'id',
  'message_id',
  'session_id',
  'time_created',
  'time_updated',
  'data',
] as const;

const logger = createLogger({ name: 'opencode-session-source' });

interface OpenCodeUsage {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

interface OpenCodeCursorState extends Record<string, unknown> {
  version: 1;
  /** Last fully consumed message, in the writer's (time_created, id) order. */
  after?: { time: number; id: string };
  turnId?: string;
  /** The open turn already imported assistant text (paragraph boundary). */
  assistantTextObserved?: true;
  usage?: OpenCodeUsage;
}

interface DatabaseRegistration {
  path: string;
  fileName: string;
  fileIdentity: string;
}

interface SourceRegistration extends DatabaseRegistration {
  descriptor: AttachedSessionDescriptor;
}

interface MessageInfo {
  role?: string;
  completed?: number;
  finish?: string;
  parentID?: string;
  summary: boolean;
  hasError: boolean;
  errorName?: string;
  errorMessage?: string;
}

interface MessageRow {
  id: string;
  time: number;
  bytes: number;
  /** Projected fields; null when the row is not valid JSON or is oversized. */
  info: MessageInfo | null;
  oversized: boolean;
}

interface PartRow {
  id: string;
  bytes: number;
  data: string | null;
}

interface OpenCodeSessionSourceOptions {
  /** OpenCode's data directory (holds `opencode*.db`), not a database file. */
  dataDir?: string;
  maxCandidates?: number;
  maxMessages?: number;
  maxBytes?: number;
  maxRowBytes?: number;
  maxEvents?: number;
  maxPartsPerMessage?: number;
  /** Messages mapped between event-loop yields in `read()`. */
  readYieldEveryMessages?: number;
  /** Test seam for the bounded event-loop yield. */
  yieldFn?: () => Promise<void>;
  /** Test seam for the one-per-reason schema/open warning. */
  warn?: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Read-only, bounded importer for OpenCode's SQLite session store.
 *
 * Current OpenCode keeps sessions in `$XDG_DATA_HOME/opencode/
 * opencode[-<channel>].db`, WAL mode. This source opens that file with
 * `readOnly` for each discovery or read and closes it immediately: it never
 * copies, writes or checkpoints it, and a WAL reader never blocks the writer.
 * (SQLite gives any WAL reader the `-wal`/`-shm` files it needs, so an empty
 * pair can appear beside a store OpenCode last closed cleanly.)
 * Only `session`, `message` and `part` are queried — the same file holds
 * account tokens and credentials, which this source never selects.
 *
 * The pre-SQLite JSON layout (`storage/session/**.json`) is not read: current
 * OpenCode migrates it into the database on first start.
 *
 * Messages are imported once they are settled — an assistant message once it
 * has `time.completed` or an error, a user message once a later message
 * exists — so an in-flight message is re-read until it stops changing and
 * the cursor only ever moves forward past whole messages.
 */
export class OpenCodeSessionSource implements AttachedSessionSource {
  readonly provider = 'opencode';
  readonly kind = 'opencode-session';
  private readonly dataDir: string;
  private readonly maxCandidates: number;
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly maxRowBytes: number;
  private readonly maxEvents: number;
  private readonly maxPartsPerMessage: number;
  private readonly warn: (
    message: string,
    meta: Record<string, unknown>,
  ) => void;
  private readonly readYieldEveryMessages: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly warned = new Set<string>();
  private readonly handles = new Map<string, SourceRegistration>();

  constructor(options: OpenCodeSessionSourceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      process.env.STATION_EXTERNAL_OPENCODE_SOURCE_ROOT ??
      defaultDataDir();
    this.maxCandidates = boundedInteger(
      'maxCandidates',
      options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      MAX_CANDIDATES_CEILING,
    );
    this.maxMessages = boundedInteger(
      'maxMessages',
      options.maxMessages ?? DEFAULT_MAX_MESSAGES,
      MAX_MESSAGES_CEILING,
    );
    this.maxBytes = boundedInteger(
      'maxBytes',
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      MAX_BYTES_CEILING,
    );
    this.maxRowBytes = boundedInteger(
      'maxRowBytes',
      options.maxRowBytes ?? Math.min(DEFAULT_MAX_ROW_BYTES, this.maxBytes),
      Math.min(MAX_ROW_BYTES_CEILING, this.maxBytes),
    );
    this.maxEvents = boundedInteger(
      'maxEvents',
      options.maxEvents ?? DEFAULT_MAX_EVENTS,
      MAX_EVENTS_CEILING,
    );
    this.maxPartsPerMessage = boundedInteger(
      'maxPartsPerMessage',
      options.maxPartsPerMessage ?? DEFAULT_MAX_PARTS_PER_MESSAGE,
      MAX_PARTS_PER_MESSAGE_CEILING,
    );
    this.readYieldEveryMessages = boundedInteger(
      'readYieldEveryMessages',
      options.readYieldEveryMessages ?? DEFAULT_READ_YIELD_EVERY_MESSAGES,
      MAX_MESSAGES_CEILING,
    );
    this.yieldFn =
      options.yieldFn ??
      (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.warn = options.warn ?? ((message, meta) => logger.warn(message, meta));
  }

  async discover(): Promise<AttachedSessionDiscoveryResult> {
    const sourceHome = deriveConfigHomeAffinity(
      SOURCE_HOME_NAMESPACE,
      this.dataDir,
    );
    if (!sourceHome) return { outcome: 'missing_root', sessions: [] };
    const listed = this.listDatabases(sourceHome.canonicalRoot);
    this.handles.clear();
    if (listed.databases.length === 0) {
      return {
        outcome: listed.outcome === 'ok' ? 'missing_root' : listed.outcome,
        sessions: [],
      };
    }

    let outcome = listed.outcome;
    const found: Array<{
      updatedAt: number;
      registration: SourceRegistration;
    }> = [];
    for (const database of listed.databases) {
      const result = await this.withDatabase(database, (db) => {
        // `time_updated` has no index upstream, so this is one scan of the
        // session table (about 12 ms warm on a 61k-session store). The
        // EXISTS probe uses `message_session_time_created_id_idx`; it skips
        // the many sessions OpenCode creates and never prompts.
        const rows = db
          .prepare(
            `SELECT id, directory, time_created, time_updated FROM session
             WHERE parent_id IS NULL AND time_archived IS NULL
               AND EXISTS (SELECT 1 FROM message WHERE message.session_id = session.id)
             ORDER BY time_updated DESC, id ASC LIMIT ?`,
          )
          .all(this.maxCandidates + 1);
        return rows;
      });
      if (!result.ok) {
        outcome = mergeOutcome(outcome, result.outcome);
        continue;
      }
      if (result.value.length > this.maxCandidates) {
        outcome = mergeOutcome(outcome, 'candidate_limit');
      }
      for (const row of result.value.slice(0, this.maxCandidates)) {
        const registration = this.registrationFor(
          database,
          sourceHome.affinity,
          row,
        );
        if (!registration) {
          outcome = mergeOutcome(outcome, 'malformed_record');
          continue;
        }
        found.push({
          updatedAt: Number(row.time_updated),
          registration,
        });
      }
    }
    found.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.registration.descriptor.sessionId.localeCompare(
          right.registration.descriptor.sessionId,
        ),
    );
    if (found.length > this.maxCandidates) {
      found.length = this.maxCandidates;
      outcome = mergeOutcome(outcome, 'candidate_limit');
    }
    const sessions: AttachedSessionDescriptor[] = [];
    for (const { registration } of found) {
      this.handles.set(registration.descriptor.sourceHandle, registration);
      sessions.push(registration.descriptor);
    }
    return { outcome, sessions };
  }

  async read(
    session: AttachedSessionDescriptor,
    previousCursor: AttachedSessionCursor = 0,
  ): Promise<AttachedSessionReadResult> {
    const registration = this.handles.get(session.sourceHandle);
    if (!registration || !sameDescriptor(registration.descriptor, session)) {
      return { outcome: 'unknown_source', events: [], cursor: 0 };
    }
    const rejected = (): AttachedSessionReadResult => ({
      outcome: 'rejected_candidate',
      events: [],
      cursor: previousCursor,
    });
    const home = resolveConfigHomeAffinity(
      SOURCE_HOME_NAMESPACE,
      this.dataDir,
      session.affinity,
    );
    if (!home || !session.affinity) return rejected();
    const current = this.databaseAt(home, registration.fileName);
    if (
      !current ||
      current.path !== registration.path ||
      current.fileIdentity !== registration.fileIdentity
    ) {
      return rejected();
    }
    const cursor = decodeCursor(previousCursor);
    if (!cursor) return rejected();

    const result = await this.withDatabase(current, async (db) => {
      const row = db
        .prepare(
          'SELECT id, directory, time_created, time_updated FROM session WHERE id = ?',
        )
        .get(session.sessionId);
      const refreshed = row
        ? this.registrationFor(current, session.affinity!, row)
        : null;
      if (
        !refreshed ||
        !sameDescriptor(registration.descriptor, refreshed.descriptor)
      ) {
        return null;
      }
      return this.readMessages(db, session, cursor);
    });
    if (!result.ok || !result.value) return rejected();
    return result.value;
  }

  private async readMessages(
    db: DatabaseSync,
    session: AttachedSessionDescriptor,
    cursor: DecodedCursor,
  ): Promise<AttachedSessionReadResult> {
    const after = cursor.state.after;
    // Only the fields this source maps are projected out of the writer's
    // JSON, inside SQLite: a user message's file diffs or a tool's metadata
    // never reach this process, and the row bound applies to what does.
    const messageRows = db
      .prepare(
        `WITH m AS (
           SELECT id, time_created AS time,
             CASE WHEN json_valid(data) THEN json_object(
               'role', data->>'$.role',
               'completed', data->'$.time.completed',
               'finish', data->>'$.finish',
               'parentID', data->>'$.parentID',
               'summary', json_type(data, '$.summary') = 'true',
               'hasError', json_type(data, '$.error') IS NOT NULL,
               'errorName', data->>'$.error.name',
               'errorMessage', substr(data->>'$.error.data.message', 1, 4096)
             ) END AS slim
           FROM message
           WHERE session_id = ?
             AND (time_created > ? OR (time_created = ? AND id > ?))
           ORDER BY time_created ASC, id ASC LIMIT ?)
         SELECT id, time, octet_length(slim) AS bytes,
           CASE WHEN octet_length(slim) <= ? THEN slim END AS data FROM m`,
      )
      .all(
        session.sessionId,
        after?.time ?? -1,
        after?.time ?? -1,
        after?.id ?? '',
        this.maxMessages + 1,
        this.maxRowBytes,
      )
      .map(messageRow);
    const partQuery = db.prepare(
      `WITH p AS (
         SELECT id,
           CASE WHEN json_valid(data) THEN json_object(
             'type', data->>'$.type',
             'text', data->>'$.text',
             'synthetic', data->'$.synthetic',
             'ignored', data->'$.ignored',
             'callID', data->>'$.callID',
             'tool', data->>'$.tool',
             'providerExecuted', data->'$.metadata.providerExecuted',
             'state', json_object(
               'status', data->>'$.state.status',
               'input', data->'$.state.input',
               'output', data->>'$.state.output',
               'error', data->>'$.state.error'
             ),
             'tokens', data->'$.tokens'
           ) END AS slim
         FROM part WHERE message_id = ? AND session_id = ?
         ORDER BY id ASC LIMIT ?)
       SELECT id, octet_length(slim) AS bytes,
         CASE WHEN octet_length(slim) <= ? THEN slim END AS data FROM p`,
    );

    let outcome: AttachedSessionSourceOutcome = 'ok';
    const events: CanonicalRuntimeEvent[] = [];
    let state = cloneState(cursor.state);
    let offset = cursor.offset;
    let bytesUsed = 0;
    const window = messageRows.slice(0, this.maxMessages);
    for (const [index, message] of window.entries()) {
      // A full page is a few hundred parts parsed on the main thread; yield
      // between message batches like the JSONL sources do between lines.
      if (index > 0 && index % this.readYieldEveryMessages === 0) {
        await this.yieldFn();
      }
      if (!message) {
        // A row whose identity columns are not the writer's types.
        return {
          outcome: 'malformed_record',
          events,
          cursor: encodeCursor(offset, state),
        };
      }
      const parts = partQuery
        .all(
          message.id,
          session.sessionId,
          this.maxPartsPerMessage + 1,
          this.maxRowBytes,
        )
        .map(partRow);
      const planned = planParts(parts, this.maxPartsPerMessage, this.maxBytes);
      const messageBytes = message.bytes + planned.bytes;
      if (bytesUsed > 0 && bytesUsed + messageBytes > this.maxBytes) {
        outcome = mergeOutcome(outcome, 'byte_limit');
        break;
      }
      const hasLater = index + 1 < messageRows.length;
      const mapped = mapMessage(
        message,
        planned,
        hasLater,
        session,
        cloneState(state),
      );
      if (mapped.kind === 'unsettled') {
        outcome = mergeOutcome(outcome, 'incomplete_tail');
        break;
      }
      if (mapped.kind === 'oversized') {
        outcome = mergeOutcome(outcome, 'line_limit');
      } else if (mapped.kind === 'malformed') {
        outcome = mergeOutcome(outcome, 'malformed_record');
      }
      if (planned.omitted > 0) outcome = mergeOutcome(outcome, 'line_limit');
      const alreadyEmitted = index === 0 ? cursor.eventIndex : 0;
      if (alreadyEmitted > mapped.events.length) {
        return {
          outcome: 'rejected_candidate',
          events: [],
          cursor: cursor.raw,
        };
      }
      const remaining = mapped.events.slice(alreadyEmitted);
      const capacity = this.maxEvents - events.length;
      if (remaining.length > capacity) {
        events.push(...remaining.slice(0, capacity));
        return {
          outcome,
          events,
          cursor: encodeCursor(offset, state, alreadyEmitted + capacity),
        };
      }
      events.push(...remaining);
      bytesUsed += messageBytes;
      state = mapped.state;
      state.after = { time: message.time, id: message.id };
      offset += 1;
      if (index === window.length - 1 && messageRows.length > window.length) {
        outcome = mergeOutcome(outcome, 'byte_limit');
      }
    }
    return { outcome, events, cursor: encodeCursor(offset, state) };
  }

  private registrationFor(
    database: DatabaseRegistration,
    affinity: ProviderSessionSourceAffinity,
    row: Record<string, unknown>,
  ): SourceRegistration | null {
    const sessionId = boundedId(row.id);
    const cwd = boundedPath(row.directory);
    const created = Number(row.time_created);
    if (!sessionId || !cwd || !Number.isSafeInteger(created)) return null;
    const threadId = `external:opencode:${digest([
      affinity.ref,
      database.fileName,
      sessionId,
    ])}`;
    return {
      ...database,
      descriptor: {
        provider: this.provider,
        sessionId,
        threadId,
        cwd,
        createdAt: millisTimestamp(created),
        sourceHandle: digest([
          this.kind,
          affinity.ref,
          database.fileName,
          database.fileIdentity,
          sessionId,
        ]),
        affinity,
      },
    };
  }

  private listDatabases(root: string): {
    outcome: AttachedSessionSourceOutcome;
    databases: DatabaseRegistration[];
  } {
    let names: string[];
    try {
      names = readdirSync(root)
        .filter((name) => DATABASE_FILE_PATTERN.test(name))
        .sort();
    } catch {
      return { outcome: 'missing_root', databases: [] };
    }
    let outcome: AttachedSessionSourceOutcome = 'ok';
    if (names.length > MAX_DATABASE_FILES) {
      names = names.slice(0, MAX_DATABASE_FILES);
      outcome = 'candidate_limit';
    }
    const databases: DatabaseRegistration[] = [];
    for (const name of names) {
      const database = this.databaseAt(root, name);
      if (database) databases.push(database);
      else outcome = mergeOutcome(outcome, 'rejected_candidate');
    }
    return { outcome, databases };
  }

  private databaseAt(
    root: string,
    fileName: string,
  ): DatabaseRegistration | null {
    if (!DATABASE_FILE_PATTERN.test(fileName)) return null;
    const candidate = join(root, fileName);
    try {
      if (!existsSync(candidate)) return null;
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const canonical = realpathSync(candidate);
      if (!canonical.startsWith(`${root}${sep}`)) return null;
      return {
        path: canonical,
        fileName,
        fileIdentity: `${stat.dev}:${stat.ino}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Open read-only, verify the schema, run `body`, close. An open failure or
   * schema mismatch fails closed for that database and is logged once per
   * database and reason, never per poll.
   */
  private async withDatabase<T>(
    database: DatabaseRegistration,
    body: (db: DatabaseSync) => T | Promise<T>,
  ): Promise<
    | { ok: true; value: T }
    | { ok: false; outcome: AttachedSessionSourceOutcome }
  > {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(database.path, {
        readOnly: true,
        timeout: BUSY_TIMEOUT_MS,
      });
      const mismatch = schemaMismatch(db);
      if (mismatch) {
        this.warnOnce(database, `schema:${mismatch}`, {
          reason: 'unsupported_schema',
          detail: mismatch,
        });
        return { ok: false, outcome: 'rejected_candidate' };
      }
      return { ok: true, value: await body(db) };
    } catch (error) {
      this.warnOnce(database, `error:${errorCode(error)}`, {
        reason: 'database_unreadable',
        code: errorCode(error),
      });
      return { ok: false, outcome: 'rejected_candidate' };
    } finally {
      try {
        db?.close();
      } catch {
        // Closing a read-only handle has nothing to flush.
      }
    }
  }

  private warnOnce(
    database: DatabaseRegistration,
    key: string,
    meta: Record<string, unknown>,
  ): void {
    const warnedKey = `${database.fileIdentity}\u0000${key}`;
    if (this.warned.has(warnedKey)) return;
    this.warned.add(warnedKey);
    // The database name is a channel label, never a path or transcript data.
    this.warn('OpenCode session store is not readable; skipping it.', {
      database: database.fileName,
      ...meta,
    });
  }
}

function schemaMismatch(db: DatabaseSync): string | null {
  const columns = (table: string): string[] =>
    db
      .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all(table)
      .map((row) => String(row.name));
  const session = columns('session');
  if (session.length === 0) return 'session:missing';
  const missing = REQUIRED_SESSION_COLUMNS.filter(
    (column) => !session.includes(column),
  );
  if (missing.length > 0) return `session:missing:${missing.join(',')}`;
  for (const [table, expected] of [
    ['message', EXACT_MESSAGE_COLUMNS],
    ['part', EXACT_PART_COLUMNS],
  ] as const) {
    const actual = columns(table);
    if (actual.length === 0) return `${table}:missing`;
    const unexpected = actual.filter(
      (column) => !(expected as readonly string[]).includes(column),
    );
    const absent = expected.filter((column) => !actual.includes(column));
    if (unexpected.length > 0 || absent.length > 0) {
      return `${table}:columns`;
    }
  }
  return null;
}

interface PlannedParts {
  /** Parts within the per-message bounds, in id order. */
  included: PartRow[];
  /** Parts dropped by the row, count or per-message byte bound. */
  omitted: number;
  bytes: number;
}

/**
 * Deterministic per message: the same rows always plan the same parts, so a
 * cursor's `eventIndex` into one message stays valid across reads.
 */
function planParts(
  parts: Array<PartRow | null>,
  maxParts: number,
  maxBytes: number,
): PlannedParts {
  const included: PartRow[] = [];
  let omitted = parts.length > maxParts ? 1 : 0;
  let bytes = 0;
  for (const part of parts.slice(0, maxParts)) {
    if (!part || part.data === null || bytes + part.bytes > maxBytes) {
      omitted += 1;
      continue;
    }
    included.push(part);
    bytes += part.bytes;
  }
  return { included, omitted, bytes };
}

type MappedMessage =
  | { kind: 'unsettled' }
  | {
      kind: 'ok' | 'oversized' | 'malformed';
      events: CanonicalRuntimeEvent[];
      state: OpenCodeCursorState;
    };

type TurnClose =
  | { kind: 'completed'; finishReason: 'stop' | 'max-tokens' | 'other' }
  | { kind: 'aborted'; reason: string }
  | { kind: 'superseded' };

/** A canonical event without the fields every event of one message shares. */
type CanonicalEventBody = CanonicalRuntimeEvent extends infer Event
  ? Event extends CanonicalRuntimeEvent
    ? Omit<Event, 'eventId' | 'provider' | 'threadId' | 'createdAt'>
    : never
  : never;

/** Per-message emission context: event ids are positional within a message. */
class MessageEmitter {
  readonly events: CanonicalRuntimeEvent[] = [];
  readonly base: {
    provider: 'opencode';
    threadId: string;
    createdAt: string;
  };

  constructor(
    private readonly session: AttachedSessionDescriptor,
    private readonly message: MessageRow,
    public state: OpenCodeCursorState,
  ) {
    this.base = {
      provider: 'opencode',
      threadId: session.threadId,
      createdAt: millisTimestamp(message.time),
    };
  }

  id(kind: string): string {
    return eventId(this.session, this.message.id, this.events.length, kind);
  }

  /** Emit an event; `eventId` and the common fields are filled in here. */
  emit(kind: string, event: CanonicalEventBody): void {
    this.events.push({
      ...this.base,
      eventId: this.id(kind),
      ...event,
    } as CanonicalRuntimeEvent);
  }

  omissionWarning(omitted: number, turnId: string | undefined): void {
    if (omitted === 0) return;
    this.emit('parts-bounded', {
      method: 'runtime.warning',
      ...(turnId ? { turnId } : {}),
      severity: 'warning',
      code: 'external_record_bounded',
      message:
        'OpenCode message parts exceeded the retained activity limit and were omitted.',
      details: { omittedPartCount: omitted },
    });
  }

  closeTurn(close: TurnClose): void {
    const turnId = this.state.turnId;
    if (!turnId) return;
    if (this.state.usage) {
      this.events.push(
        usageEvent(this.base, this.id('usage'), turnId, this.state.usage),
      );
    }
    if (close.kind === 'aborted') {
      this.emit('turn-aborted', {
        method: 'turn.aborted',
        turnId,
        reason: close.reason,
      });
    } else {
      this.emit('turn-completed', {
        method: 'turn.completed',
        turnId,
        finishReason: close.kind === 'completed' ? close.finishReason : 'other',
        ...(close.kind === 'superseded'
          ? { metadata: { source: PROMPT_SOURCE, closedBy: 'next-prompt' } }
          : {}),
      });
    }
    this.state = {
      version: 1,
      ...(this.state.after ? { after: this.state.after } : {}),
    };
  }
}

/**
 * One settled message to canonical events. A turn is a user message plus the
 * assistant messages that answer it; it closes the way OpenCode's own prompt
 * loop exits (`SessionPrompt`): an assistant error, or a finish other than
 * `tool-calls`/`unknown` with no client-executed tool call left to answer.
 */
function mapMessage(
  message: MessageRow,
  planned: PlannedParts,
  hasLater: boolean,
  session: AttachedSessionDescriptor,
  previous: OpenCodeCursorState,
): MappedMessage {
  const info = message.info;
  if (!hasLater && !isSettled(info)) return { kind: 'unsettled' };
  const state = cloneState(previous);
  if (message.oversized) return { kind: 'oversized', events: [], state };
  if (!info) return { kind: 'malformed', events: [], state };
  if (info.role !== 'user' && info.role !== 'assistant') {
    return { kind: 'malformed', events: [], state };
  }
  const parts = planned.included
    .map((part) => ({ id: part.id, data: parseRecord(part.data!) }))
    .filter((part): part is ParsedPart => part.data !== null);
  const emitter = new MessageEmitter(session, message, state);
  if (info.role === 'user') {
    mapUserMessage(emitter, message.id, parts, planned.omitted);
  } else {
    mapAssistantMessage(emitter, message.id, info, parts, planned.omitted);
  }
  return { kind: 'ok', events: emitter.events, state: emitter.state };
}

interface ParsedPart {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Settled: an assistant message once completed or failed. Any message also
 * settles once the session has moved on to a later one (checked by the
 * caller): a crashed or interrupted write never completes, and must not hold
 * the cursor forever. A trailing user message waits, because its parts are
 * written after its row.
 */
function isSettled(info: MessageInfo | null): boolean {
  return (
    info?.role === 'assistant' &&
    (info.hasError || Number.isSafeInteger(info.completed))
  );
}

function mapUserMessage(
  emitter: MessageEmitter,
  messageId: string,
  parts: ParsedPart[],
  omitted: number,
): void {
  if (parts.some((part) => text(part.data.type) === 'compaction')) {
    emitter.emit('context-compacted', {
      method: 'extension.notification',
      namespace: PROMPT_SOURCE,
      type: 'context-compacted',
      payload: { source: 'provider-event' },
    });
    return;
  }
  // A prompt that arrives while a turn is still open (queued behind it, or
  // after an interrupted write) is answered as its own turn by OpenCode, so
  // the open one ends here.
  emitter.closeTurn({ kind: 'superseded' });
  const prompt = parts
    .filter(
      (part) =>
        text(part.data.type) === 'text' &&
        isVisibleText(part.data) &&
        typeof part.data.text === 'string',
    )
    .map((part) => part.data.text as string)
    .join(PARAGRAPH_BREAK);
  const bounded = prompt
    ? boundedPrompt(prompt, {
        maxBytes: MAX_PROMPT_BYTES,
        source: PROMPT_SOURCE,
      })
    : undefined;
  emitter.state.turnId = messageId;
  emitter.emit('turn-started', {
    method: 'turn.started',
    turnId: messageId,
    ...(bounded ? { prompt: bounded.value } : {}),
    ...(bounded?.metadata ? { metadata: bounded.metadata } : {}),
  });
  emitter.omissionWarning(omitted, messageId);
}

function mapAssistantMessage(
  emitter: MessageEmitter,
  messageId: string,
  info: MessageInfo,
  parts: ParsedPart[],
  omitted: number,
): void {
  // A compaction summary restates the conversation for the model; the
  // compaction notification already marks the boundary.
  if (info.summary) return;
  if (!emitter.state.turnId) {
    const turnId = info.parentID ?? messageId;
    emitter.state.turnId = turnId;
    emitter.emit('turn-started', { method: 'turn.started', turnId });
  }
  const turnId = emitter.state.turnId!;
  let openToolCalls = false;
  for (const part of parts) {
    const type = text(part.data.type);
    if (type === 'text' || type === 'reasoning') {
      mapTextPart(emitter, turnId, part, type);
    } else if (type === 'tool') {
      if (mapToolPart(emitter, turnId, part.data)) openToolCalls = true;
    } else if (type === 'step-finish') {
      const step = decodeUsage(part.data.tokens);
      if (step) emitter.state.usage = addUsage(emitter.state.usage, step);
    }
  }
  emitter.omissionWarning(omitted, turnId);

  if (info.hasError) {
    if (info.errorName === 'MessageAbortedError') {
      emitter.closeTurn({
        kind: 'aborted',
        reason: diagnosticText(info.errorMessage) ?? 'aborted in OpenCode',
      });
      return;
    }
    emitter.emit('turn-error', {
      method: 'runtime.error',
      turnId,
      severity: 'error',
      message:
        diagnosticText(info.errorMessage) ??
        info.errorName ??
        'OpenCode reported an error.',
    });
    emitter.closeTurn({ kind: 'completed', finishReason: 'other' });
  } else if (
    info.finish !== undefined &&
    info.finish !== 'tool-calls' &&
    info.finish !== 'unknown' &&
    !openToolCalls
  ) {
    emitter.closeTurn({
      kind: 'completed',
      finishReason: finishReason(info.finish),
    });
  }
}

function isVisibleText(data: Record<string, unknown>): boolean {
  return data.synthetic !== true && data.ignored !== true;
}

function mapTextPart(
  emitter: MessageEmitter,
  turnId: string,
  part: ParsedPart,
  type: 'text' | 'reasoning',
): void {
  const value = part.data.text;
  if (typeof value !== 'string' || !value || !isVisibleText(part.data)) return;
  let delta = value;
  if (type === 'text') {
    // A later text part in the same turn opens a new paragraph.
    if (
      emitter.state.assistantTextObserved &&
      !value.startsWith(PARAGRAPH_BREAK)
    ) {
      delta = `${PARAGRAPH_BREAK}${value}`;
    }
    emitter.state.assistantTextObserved = true;
  }
  for (const [chunk, piece] of utf8Chunks(
    delta,
    MAX_TEXT_CHUNK_BYTES,
  ).entries()) {
    emitter.emit(`${type}-${chunk}`, {
      method:
        type === 'text' ? 'content.text-delta' : 'content.reasoning-delta',
      turnId,
      itemId: chunk === 0 ? part.id : `${part.id}:${chunk}`,
      delta: piece,
    });
  }
}

/** Returns whether the call is one the client executes (keeps the loop open). */
function mapToolPart(
  emitter: MessageEmitter,
  turnId: string,
  data: Record<string, unknown>,
): boolean {
  const callId = boundedId(data.callID);
  const toolName = boundedId(data.tool);
  const toolState = asRecord(data.state);
  if (!callId || !toolName || !toolState) return false;
  const call = { turnId, itemId: callId, toolCallId: callId };
  const projectedArguments = projectBoundedToolOutput(toolState.input ?? {});
  emitter.emit('tool-started', {
    method: 'tool.started',
    ...call,
    toolName,
    arguments: projectedArguments.value,
  });
  if (projectedArguments.receipt) {
    emitter.emit('tool-arguments-bounded', {
      method: 'runtime.warning',
      turnId,
      severity: 'warning',
      code: 'external_tool_arguments_bounded',
      message: 'OpenCode tool arguments exceeded the retained activity limit.',
      details: { toolCallId: callId, receipt: projectedArguments.receipt },
    });
  }
  const status = text(toolState.status);
  if (status === 'completed') {
    const output = projectBoundedToolOutput(
      typeof toolState.output === 'string' ? toolState.output : '',
    );
    emitter.emit('tool-completed', {
      method: 'tool.completed',
      ...call,
      toolName,
      status: 'success',
      output: output.value,
      ...(output.receipt ? { outputReceipt: output.receipt } : {}),
    });
  } else if (status === 'error') {
    const failure = diagnosticText(toolState.error) ?? 'Tool failed.';
    emitter.emit('tool-completed', {
      method: 'tool.completed',
      ...call,
      toolName,
      status: 'error',
      error: failure,
      output: failure,
    });
  } else {
    // A pending/running call in a settled message: OpenCode wrote no
    // verdict, and this source does not invent one.
    emitter.emit('tool-status-unknown', {
      method: 'runtime.warning',
      turnId,
      severity: 'warning',
      code: 'external_tool_result_status_unknown',
      message:
        'OpenCode recorded this tool call without a success or failure verdict.',
      details: { toolCallId: callId, toolName },
    });
  }
  return data.providerExecuted !== true;
}

function usageEvent(
  base: { provider: 'opencode'; threadId: string; createdAt: string },
  eventIdValue: string,
  turnId: string,
  usage: OpenCodeUsage,
): CanonicalRuntimeEvent {
  // OpenCode's step usage (`Session.getUsage`) stores input with cache reads
  // and writes subtracted, and output with reasoning subtracted; completion
  // here is output plus reasoning. OpenCode's `cost` is its own estimate from
  // a price catalog, not a provider-reported charge, so it is not carried.
  return {
    ...base,
    eventId: eventIdValue,
    method: 'token-usage.updated',
    turnId,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

function decodeUsage(raw: unknown): OpenCodeUsage | null {
  const tokens = asRecord(raw);
  const cache = asRecord(tokens?.cache);
  const input = tokenCount(tokens?.input);
  const output = tokenCount(tokens?.output);
  const reasoning = tokenCount(tokens?.reasoning) ?? 0;
  if (input === undefined || output === undefined) return null;
  return {
    prompt: input,
    completion: output + reasoning,
    cacheRead: tokenCount(cache?.read) ?? 0,
    cacheWrite: tokenCount(cache?.write) ?? 0,
  };
}

function addUsage(
  previous: OpenCodeUsage | undefined,
  added: OpenCodeUsage,
): OpenCodeUsage {
  const sum = (left: number, right: number): number =>
    Math.min(left + right, Number.MAX_SAFE_INTEGER);
  return previous
    ? {
        prompt: sum(previous.prompt, added.prompt),
        completion: sum(previous.completion, added.completion),
        cacheRead: sum(previous.cacheRead, added.cacheRead),
        cacheWrite: sum(previous.cacheWrite, added.cacheWrite),
      }
    : added;
}

function finishReason(
  finish: string | undefined,
): 'stop' | 'max-tokens' | 'other' {
  if (finish === 'stop') return 'stop';
  if (finish === 'length') return 'max-tokens';
  return 'other';
}

interface DecodedCursor {
  raw: AttachedSessionCursor;
  offset: number;
  eventIndex: number;
  state: OpenCodeCursorState;
}

function decodeCursor(previous: AttachedSessionCursor): DecodedCursor | null {
  if (typeof previous === 'number') {
    return previous === 0
      ? { raw: previous, offset: 0, eventIndex: 0, state: { version: 1 } }
      : null;
  }
  if (!isCount(previous.offset)) return null;
  if (
    previous.turnId !== undefined ||
    previous.usage !== undefined ||
    previous.usageDeferred !== undefined
  ) {
    return null;
  }
  const eventIndex = previous.eventIndex ?? 0;
  if (!isCount(eventIndex)) return null;
  const state = decodeState(previous.sourceState);
  if (!state) return null;
  // A consumed message is always recorded as the resume position.
  if (previous.offset > 0 !== (state.after !== undefined)) return null;
  return { raw: previous, offset: previous.offset, eventIndex, state };
}

function decodeState(
  raw: Record<string, unknown> | undefined,
): OpenCodeCursorState | null {
  if (raw === undefined) return { version: 1 };
  if (!isPlainRecord(raw)) return null;
  const allowed = [
    'version',
    'after',
    'turnId',
    'assistantTextObserved',
    'usage',
  ];
  if (!Object.keys(raw).every((key) => allowed.includes(key))) return null;
  if (raw.version !== 1) return null;
  const state: OpenCodeCursorState = { version: 1 };
  if (raw.after !== undefined) {
    const after = asRecord(raw.after);
    const id = boundedId(after?.id);
    if (
      !after ||
      Object.keys(after).length !== 2 ||
      !isCount(after.time) ||
      !id
    ) {
      return null;
    }
    state.after = { time: after.time as number, id };
  }
  if (raw.turnId !== undefined) {
    const turnId = boundedId(raw.turnId);
    if (!turnId) return null;
    state.turnId = turnId;
  }
  if (raw.assistantTextObserved !== undefined) {
    if (raw.assistantTextObserved !== true || !state.turnId) return null;
    state.assistantTextObserved = true;
  }
  if (raw.usage !== undefined) {
    const usage = asRecord(raw.usage);
    const keys = ['prompt', 'completion', 'cacheRead', 'cacheWrite'] as const;
    if (
      !usage ||
      !state.turnId ||
      Object.keys(usage).length !== keys.length ||
      !keys.every((key) => isCount(usage[key]))
    ) {
      return null;
    }
    state.usage = {
      prompt: usage.prompt as number,
      completion: usage.completion as number,
      cacheRead: usage.cacheRead as number,
      cacheWrite: usage.cacheWrite as number,
    };
  }
  return state;
}

function encodeCursor(
  offset: number,
  state: OpenCodeCursorState,
  eventIndex?: number,
): AttachedSessionCursor {
  return {
    offset,
    sourceState: structuredClone(state),
    ...(eventIndex ? { eventIndex } : {}),
  };
}

function cloneState(state: OpenCodeCursorState): OpenCodeCursorState {
  return structuredClone(state);
}

function messageRow(row: Record<string, unknown>): MessageRow | null {
  const id = boundedId(row.id);
  const time = row.time;
  if (!id || !isCount(time)) return null;
  const bytes = isCount(row.bytes) ? row.bytes : 0;
  const projected = typeof row.data === 'string' ? parseRecord(row.data) : null;
  return {
    id,
    time,
    bytes,
    oversized: isCount(row.bytes) && typeof row.data !== 'string',
    info: projected
      ? {
          role: text(projected.role),
          completed: isCount(projected.completed)
            ? projected.completed
            : undefined,
          finish: text(projected.finish),
          parentID: boundedId(projected.parentID),
          summary: projected.summary === 1 || projected.summary === true,
          hasError: projected.hasError === 1 || projected.hasError === true,
          errorName: text(projected.errorName),
          errorMessage: text(projected.errorMessage),
        }
      : null,
  };
}

function partRow(row: Record<string, unknown>): PartRow | null {
  const id = boundedId(row.id);
  const bytes = row.bytes;
  if (!id || !isCount(bytes)) return null;
  return { id, bytes, data: typeof row.data === 'string' ? row.data : null };
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function defaultDataDir(): string {
  // OpenCode resolves its data directory with `xdg-basedir` on every
  // platform, macOS included: $XDG_DATA_HOME, else ~/.local/share.
  const xdg = process.env.XDG_DATA_HOME;
  return join(
    xdg?.startsWith('/') ? xdg : join(homedir(), '.local', 'share'),
    'opencode',
  );
}

function eventId(
  session: AttachedSessionDescriptor,
  messageId: string,
  index: number,
  kind: string,
): string {
  return `attached:opencode:${digest([
    session.threadId,
    session.sessionId,
    messageId,
    index,
    kind,
  ])}`;
}

function sameDescriptor(
  expected: AttachedSessionDescriptor,
  actual: AttachedSessionDescriptor,
): boolean {
  return (
    actual.provider === expected.provider &&
    actual.sessionId === expected.sessionId &&
    actual.threadId === expected.threadId &&
    actual.cwd === expected.cwd &&
    actual.createdAt === expected.createdAt &&
    actual.sourceHandle === expected.sourceHandle &&
    actual.affinity?.kind === expected.affinity?.kind &&
    actual.affinity?.ref === expected.affinity?.ref
  );
}

function mergeOutcome(
  current: AttachedSessionSourceOutcome,
  next: AttachedSessionSourceOutcome,
): AttachedSessionSourceOutcome {
  const priority: Record<AttachedSessionSourceOutcome, number> = {
    ok: 0,
    incomplete_tail: 1,
    byte_limit: 2,
    line_limit: 3,
    candidate_limit: 4,
    malformed_record: 5,
    rejected_candidate: 6,
    missing_root: 7,
    unknown_source: 8,
  };
  return priority[next] > priority[current] ? next : current;
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code.slice(0, 64);
  }
  return 'unknown';
}

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function millisTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : EPOCH;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function diagnosticText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText
    ? truncateJsonString(valueText, MAX_DIAGNOSTIC_TEXT_BYTES).value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function boundedId(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && Buffer.byteLength(valueText) <= MAX_ID_BYTES
    ? valueText
    : undefined;
}

function boundedPath(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && Buffer.byteLength(valueText) <= MAX_PATH_BYTES
    ? valueText
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedInteger(name: string, value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(
      `${name} must be an integer from 1 through ${ceiling}.`,
    );
  }
  return value;
}
