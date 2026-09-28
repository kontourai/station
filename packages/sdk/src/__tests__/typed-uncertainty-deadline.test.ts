/**
 * #2377 C2b review: at the SDK sites that classify a failure into their own
 * typed uncertainty, a request deadline that fires while the body is read is
 * the same uncertainty as one that fires before the headers. Each site is
 * driven twice: pre-header (a server that never answers) and mid-body (200
 * headers, then a stalled body), and both must give the site's typed error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StationRequestTimeoutError,
  setClientRequestTimeout,
} from '../client/http';
import { resolveConversationOpen } from '../conversation-open';
import {
  AdoptSessionError,
  adoptOrchestrationSession,
} from '../query-domains/chatRuntimeOrchestration';
import {
  launchScheduledCheckStarter,
  ScheduledCheckStarterResponseError,
} from '../starter-work';

const API = 'https://station.test';

afterEach(() => {
  setClientRequestTimeout(undefined);
  vi.unstubAllGlobals();
});

function never() {
  return vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      }),
  );
}

function stalledBody() {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
          signal?.addEventListener('abort', () =>
            controller.error(signal.reason ?? new Error('aborted')),
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

const phases = [
  ['before the headers', never],
  ['mid-body', stalledBody],
] as const;

async function failure(call: () => Promise<unknown>): Promise<unknown> {
  setClientRequestTimeout(20);
  return call().catch((caught: unknown) => caught);
}

describe.each(phases)('a deadline that fires %s', (_phase, server) => {
  it('adoptOrchestrationSession: uncertain-no-response, retryable', async () => {
    vi.stubGlobal('fetch', server());
    const error = await failure(() =>
      adoptOrchestrationSession({ sourceThreadId: 's1', apiBase: API }),
    );
    expect(error).toBeInstanceOf(AdoptSessionError);
    expect(error).toMatchObject({
      failureClass: 'uncertain-no-response',
      retryable: true,
    });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(
      StationRequestTimeoutError,
    );
  });

  it('launchScheduledCheckStarter: ScheduledCheckStarterResponseError', async () => {
    vi.stubGlobal('fetch', server());
    const error = await failure(() =>
      launchScheduledCheckStarter({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-deadline',
        apiBase: API,
      } as never),
    );
    expect(error).toBeInstanceOf(ScheduledCheckStarterResponseError);
    expect(error).toMatchObject({ operationId: 'scheduled-check-deadline' });
  });

  it("resolveConversationOpen: 'network'", async () => {
    vi.stubGlobal('fetch', server());
    const error = await failure(() => resolveConversationOpen('c1', API));
    expect(error).toMatchObject({ kind: 'network' });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(
      StationRequestTimeoutError,
    );
  });
});
