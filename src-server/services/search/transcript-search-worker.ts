/** Read-only first-party SQLite execution. No EventStore, migrations, or authority construction. */
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import {
  messageSearchExcerpt,
  querySessionOwner,
  queryTranscriptMessage,
  queryTranscriptMessages,
  queryTranscriptSession,
} from '../orchestration/transcript-search-queries.js';
import {
  parseTranscriptReadRequest,
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
port.on('message', (wire: unknown) => {
  if (typeof wire !== 'string' || Buffer.byteLength(wire) > 2048)
    throw new TypeError('Invalid transcript operation');
  const request = parseTranscriptReadRequest(JSON.parse(wire));
  if (!request) throw new TypeError('Invalid transcript operation');
  let result: TranscriptReadResult = { state: 'unavailable' };
  try {
    result =
      request.type === 'session-owner'
        ? {
            state: 'available',
            owner: querySessionOwner(database, request.threadId, true) ?? null,
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
            : {
                state: 'available',
                rows: queryTranscriptMessages(database, request, true).map(
                  (row) => ({
                    conversationId: row.threadId,
                    matchedEventId: row.eventId,
                    messageId:
                      row.role === 'assistant' && row.turnAnchorId
                        ? `${row.turnAnchorId}:assistant`
                        : `${row.eventId}:user`,
                    role: row.role,
                    excerpt: messageSearchExcerpt(row.content, request.query),
                    ...(row.projectSlug
                      ? { projectSlug: row.projectSlug }
                      : {}),
                    ...(row.agentSlug ? { agentSlug: row.agentSlug } : {}),
                    ...(row.engine ? { engine: row.engine } : {}),
                  }),
                ),
              };
  } catch {
    /* Failure never becomes an authoritative empty/ownerless result. */
  }
  let reply = JSON.stringify({ id: request.id, result });
  if (Buffer.byteLength(reply) > 64 * 1024)
    reply = JSON.stringify({
      id: request.id,
      result: { state: 'unavailable' },
    });
  port.postMessage(reply);
});
