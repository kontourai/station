import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchProvider,
} from '@kontourai/station-contracts/unified-search';
import {
  createOwnedSearchReadWorker,
  type OwnedSearchReadWorker,
  type OwnedSearchReadWorkerTestOptions,
} from './owned-search-read-worker.js';
import { boundedTaskText, taskReadRequest } from './task-search-protocol.js';
import { parseUnifiedSearchProviderPage } from './unified-search-service.js';

export interface IsolatedTaskSearch
  extends Pick<OwnedSearchReadWorker, 'inspect' | 'close'> {
  readonly provider: UnifiedSearchProvider;
}
export type TaskSearchTestOptions = OwnedSearchReadWorkerTestOptions;

/** TaskGraph binds one canonical path; requests cannot select files or executable code. */
export function createIsolatedTaskSearch(
  owner: { storePath: string; stationId: string },
  test: TaskSearchTestOptions = {},
): IsolatedTaskSearch {
  if (!boundedTaskText(owner.stationId, 256))
    throw new TypeError('Invalid Task read owner');
  const stationId = owner.stationId;
  const worker = createOwnedSearchReadWorker(
    { kind: 'task', path: owner.storePath },
    test,
  );
  return {
    inspect: worker.inspect,
    close: worker.close,
    provider: {
      descriptor: {
        id: 'station.tasks',
        version: '1.0.0',
        owner: { kind: 'station', stationId },
        kinds: ['task'],
      },
      async search(request, signal) {
        let limit = 0;
        const result = await worker.execute(
          (id) => {
            const input = taskReadRequest(request, id);
            if (input) limit = input.limit;
            return input ? JSON.stringify(input) : null;
          },
          (value) => {
            const page = parseUnifiedSearchProviderPage(
              value,
              { kind: 'station', stationId },
              limit,
            );
            return !page ||
              ('results' in page &&
                page.results.some((result) => result.kind !== 'task'))
              ? null
              : page;
          },
          signal,
        );
        return (
          result ?? {
            version: UNIFIED_SEARCH_V1,
            state: 'unavailable',
            reason: 'source-unavailable',
          }
        );
      },
    },
  };
}
