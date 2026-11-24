/** Read-only first-party SQLite execution. No EventStore, migrations, or authority construction. */
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import {
  messageSearchExcerpt,
  querySessionOwner,
  queryTranscriptMessage,
  queryTranscriptMessagePage,
  queryTranscriptMessages,
  queryTranscriptSession,
} from '../orchestration/transcript-search-queries.js';
import { errorClassFields } from './search-read-refusal.js';
import {
  MAX_SCOPED_TRANSCRIPT_REQUEST_BYTES,
  parseTranscriptReadRequest,
  type TranscriptReadRequest,
  type TranscriptReadResult,
} from './transcript-search-protocol.js';

const port = parentPort;
const databasePath: unknown = workerData?.databasePath;
if (
  !port ||
  typeof databasePath !== 'string' ||
  databasePath.length > 4096 ||
  !isAbsolute(databasePath)
)
  throw new TypeError('Invalid transcript owner');
// readOnly refuses a missing database instead of creating a parallel empty truth.
const database = new DatabaseSync(databasePath, {
  readOnly: true,
  timeout: 1000,
});
database.exec('PRAGMA query_only = ON');
const snapshotOwner = randomUUID();
const readVersion = database.prepare('PRAGMA data_version');
const version = () => Number(readVersion.get()?.data_version);

function searchMessages(
  request: Extract<TranscriptReadRequest, { type: 'message-search' }>,
): TranscriptReadResult {
  if (!request.snapshot) return readMessages(request);
  database.exec('BEGIN');
  try {
    // Establish the SQLite read snapshot before comparing its revision.
    database.prepare('SELECT name FROM sqlite_schema LIMIT 1').get();
    if (
      request.snapshot.owner !== snapshotOwner ||
      request.snapshot.version !== version()
    )
      return { state: 'unavailable' };
    return readMessages(request);
  } finally {
    database.exec('ROLLBACK');
  }
}

function readMessages(
  request: Extract<TranscriptReadRequest, { type: 'message-search' }>,
): TranscriptReadResult {
  return {
    state: 'available',
    rows: queryTranscriptMessages(database, request, true).map((row) => ({
      conversationId: row.threadId,
      matchedEventId: row.eventId,
      messageId:
        row.role === 'assistant' && row.turnAnchorId
          ? `${row.turnAnchorId}:assistant`
          : `${row.eventId}:user`,
      role: row.role,
      excerpt: messageSearchExcerpt(row.content, request.query),
      ...(row.projectSlug ? { projectSlug: row.projectSlug } : {}),
      ...(row.agentSlug ? { agentSlug: row.agentSlug } : {}),
      ...(row.engine ? { engine: row.engine } : {}),
    })),
  };
}

port.on('message', (wire: unknown) => {
  if (typeof wire !== 'string')
    throw new TypeError('Invalid transcript operation');
  const bytes = Buffer.byteLength(wire);
  if (bytes > MAX_SCOPED_TRANSCRIPT_REQUEST_BYTES)
    throw new TypeError('Invalid transcript operation');
  const request = parseTranscriptReadRequest(JSON.parse(wire));
  if (
    !request ||
    (bytes > 2048 &&
      !(request.type === 'message-search' && request.threadIds !== undefined))
  )
    throw new TypeError('Invalid transcript operation');
  let result: TranscriptReadResult = { state: 'unavailable' };
  try {
    result =
      request.type === 'session-owner'
        ? {
            state: 'available',
            owner: querySessionOwner(database, request.threadId, true) ?? null,
          }
        : request.type === 'message-page'
          ? {
              state: 'available',
              page: queryTranscriptMessagePage(database, request),
            }
          : request.type === 'message-open'
            ? {
                state: 'available',
                target: queryTranscriptMessage(database, request),
              }
            : request.type === 'session-open'
              ? {
                  state: 'available',
                  session: queryTranscriptSession(database, request),
                }
              : request.type === 'search-snapshot'
                ? {
                    state: 'available',
                    snapshot: { owner: snapshotOwner, version: version() },
                  }
                : searchMessages(request);
  } catch (error) {
    // Failure never becomes an authoritative empty/ownerless result. Its
    // CLASS (constructor name, `code`, SQLite `errcode`) travels with the
    // refusal so the owner's log can name it (#2460); its message does not,
    // because a query error can quote the query.
    result = {
      state: 'unavailable',
      cause: { kind: 'query-error', ...errorClassFields(error) },
    };
  }
  let reply = JSON.stringify({ id: request.id, result });
  if (Buffer.byteLength(reply) > 64 * 1024)
    reply = JSON.stringify({
      id: request.id,
      result: { state: 'unavailable', cause: { kind: 'reply-too-large' } },
    });
  port.postMessage(reply);
});

// station#1707: the LAST top-level statement, so the owner learns this worker
// is usable only once its entry module has been transformed and evaluated and
// this worker's read-only database is open — not merely when the thread began
// executing JS, which is all `worker.on('online')` reports and which lands
// ~40-60ms earlier under load. The owner settles readiness on this sentinel;
// a read waiting for it is waiting for a worker that can actually answer.
port.postMessage({ type: 'ready' });
