/** Trusted built-in CPU isolation, not a plugin/security sandbox. No callbacks cross this port. */
import { isAbsolute } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { readTaskGraphForIsolatedSearch } from '../projects/task-graph-service.js';
import { createPersonalTaskSearchProvider } from './station-search-providers.js';
import {
  parseTaskReadRequest,
  TASK_SEARCH_LIMITS,
} from './task-search-protocol.js';

const port = parentPort;
const storePath: unknown = workerData?.storePath;
if (
  !port ||
  typeof storePath !== 'string' ||
  storePath.length > 4096 ||
  !isAbsolute(storePath)
)
  throw new TypeError('Task search worker needs its owner-bound store');
const path = storePath;
const unavailable = {
  version: UNIFIED_SEARCH_V1,
  state: 'unavailable',
  reason: 'source-unavailable',
};
const provider = createPersonalTaskSearchProvider({
  // This descriptor never crosses the port; the parent owns Station identity.
  stationId: 'worker-private',
  source: {
    listAuthorizedTasks: () =>
      readTaskGraphForIsolatedSearch(path, TASK_SEARCH_LIMITS.fileBytes),
  },
});
let busy = false;
port.on('message', async (wire: unknown) => {
  if (
    busy ||
    typeof wire !== 'string' ||
    Buffer.byteLength(wire) > TASK_SEARCH_LIMITS.requestBytes
  )
    throw new TypeError('Invalid Task worker request');
  const request = parseTaskReadRequest(JSON.parse(wire));
  if (!request) throw new TypeError('Invalid Task worker operation');
  busy = true;
  let page: unknown = unavailable;
  try {
    if (request.type === 'task-open') {
      const task = readTaskGraphForIsolatedSearch(
        path,
        TASK_SEARCH_LIMITS.fileBytes,
      ).find(
        (candidate) =>
          candidate.id === request.taskId &&
          candidate.projectId === request.projectId,
      );
      page = task
        ? {
            state: 'resolved',
            target: {
              kind: 'task',
              taskId: task.id,
              projectId: task.projectId,
            },
          }
        : { state: 'not-found' };
    } else
      page = request.includeTasks
        ? await provider.search(
            {
              version: UNIFIED_SEARCH_V1,
              query: request.query,
              limit: request.limit,
              filters: {
                ...(request.projectId ? { projectId: request.projectId } : {}),
                ...(request.taskId ? { taskId: request.taskId } : {}),
              },
            },
            new AbortController().signal,
          )
        : { version: UNIFIED_SEARCH_V1, state: 'available', results: [] };
  } catch {
    // Corruption/oversize/I/O failure never become an authoritative empty list.
    if (request.type === 'task-open') page = { state: 'unavailable' };
  }
  let reply = JSON.stringify({ id: request.id, page });
  if (Buffer.byteLength(reply) > TASK_SEARCH_LIMITS.responseBytes)
    reply = JSON.stringify({ id: request.id, page: unavailable });
  port.postMessage(reply);
  busy = false;
});
