import {
  createOwnedSearchReadWorker,
  type OwnedSearchReadWorker,
  type OwnedSearchReadWorkerTestOptions,
} from './owned-search-read-worker.js';
import {
  parseTranscriptReadRequest,
  parseTranscriptReadResult,
  type TranscriptMessageOpenFact,
  type TranscriptReadRequest,
  type TranscriptSearchMatch,
  type TranscriptSessionOpenFact,
  transcriptMessageOpenRequest,
  transcriptMessageRequest,
  transcriptSessionOpenRequest,
} from './transcript-search-protocol.js';

/** Database owner only. Callers must still apply the live SessionAuthorization policy. */
export interface IsolatedTranscriptReads
  extends Pick<OwnedSearchReadWorker, 'close' | 'inspect'> {
  search(
    input: {
      query: string;
      ownerUserId: string;
      tenantId?: string;
      projectId?: string;
      limit: number;
    },
    signal?: AbortSignal,
  ): Promise<TranscriptSearchMatch[]>;
  readMessage(
    input: {
      threadId: string;
      matchedEventId: string;
      ownerUserId: string;
      tenantId?: string;
    },
    signal?: AbortSignal,
  ): Promise<TranscriptMessageOpenFact | null>;
  readSession(
    input: { threadId: string; ownerUserId: string; tenantId?: string },
    signal?: AbortSignal,
  ): Promise<TranscriptSessionOpenFact | null>;
  readOwner(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}
export function createIsolatedTranscriptReads(
  databasePath: string,
  test: OwnedSearchReadWorkerTestOptions = {},
): IsolatedTranscriptReads {
  const worker = createOwnedSearchReadWorker(
    { kind: 'transcript', path: databasePath },
    test,
  );
  async function execute(
    build: (id: number) => TranscriptReadRequest | null,
    signal?: AbortSignal,
  ) {
    let captured: TranscriptReadRequest | null = null;
    const result = await worker.execute(
      (id) => {
        captured = build(id);
        return captured ? JSON.stringify(captured) : null;
      },
      (value) => (captured ? parseTranscriptReadResult(value, captured) : null),
      signal,
    );
    if (result?.state !== 'available')
      throw new Error('Transcript read unavailable');
    return result;
  }
  return {
    inspect: worker.inspect,
    close: worker.close,
    async search(input, signal) {
      const result = await execute(
        (id) => transcriptMessageRequest(input, id),
        signal,
      );
      if (!('rows' in result)) throw new Error('Transcript read unavailable');
      return result.rows;
    },
    async readOwner(threadId, signal) {
      const result = await execute(
        (id) =>
          parseTranscriptReadRequest({ type: 'session-owner', threadId, id }),
        signal,
      );
      if (!('owner' in result)) throw new Error('Transcript read unavailable');
      return result.owner ?? undefined;
    },
    async readMessage(input, signal) {
      const result = await execute(
        (id) => transcriptMessageOpenRequest(input, id),
        signal,
      );
      if (!('target' in result)) throw new Error('Transcript read unavailable');
      return result.target;
    },
    async readSession(input, signal) {
      const result = await execute(
        (id) => transcriptSessionOpenRequest(input, id),
        signal,
      );
      if (!('session' in result))
        throw new Error('Transcript read unavailable');
      return result.session;
    },
  };
}
