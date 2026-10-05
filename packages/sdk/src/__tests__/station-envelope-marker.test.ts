import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import {
  cancelAttachmentStage,
  getAttachmentStagingCapability,
  uploadAttachmentStage,
  xhrAttachmentStageUpload,
} from '../client/attachment-staging';
import { ChatHttpError } from '../client/chatHttpError';
import { getConversationHandoffStatus } from '../client/execution';
import {
  getJson,
  notifyCredentialChanged,
  setClientCredentialResolver,
} from '../client/http';
import { steerTurn } from '../client/orchestration';
import { sendExecutionMessage } from '../client/send-execution-message';
import {
  isStationAnswer,
  observeStationResponse,
  resetStationEnvelopeObservations,
} from '../client/station-envelope';
import { dispatchOrchestrationCommand } from '../query-domains/chatRuntimeOrchestration';
import { streamConversationTurn } from '../query-domains/chatRuntimeStream';

/**
 * #2842: who answered a refusal is decided by the response marker, not by the
 * body's shape. Every case drives a real fetcher over a stubbed `fetch`, so
 * the response passes through the request seam that observes the marker and
 * the producer that reads it.
 */

// Pinned beside the contract constant, so a rename there fails here.
const MARKER = 'x-station-envelope';

const STATION = 'http://station.test';
const OLD_STATION = 'http://old-station.test';

const REFUSAL = { success: false, error: 'no', code: 'refused' };
const AUTH_REFUSAL = { error: { code: 'forbidden' } };

function json(body: unknown, status: number, marked: boolean): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(marked ? { [MARKER]: '1' } : {}),
    },
  });
}

const message = {
  agentId: 'writer',
  message: 'hello',
  idempotencyKey: 'k1',
} as never;

/** One producer of `ChatHttpError.stationEnvelope` per request seam. */
const producers: ReadonlyArray<
  readonly [string, (apiBase: string) => Promise<unknown>]
> = [
  [
    'execution send (mutateJson)',
    (apiBase) => sendExecutionMessage(apiBase, message),
  ],
  [
    'handoff status (getJson)',
    (apiBase) => getConversationHandoffStatus(apiBase, 'c1', 'k1'),
  ],
  [
    'attachment stage cancel (mutateJson)',
    (apiBase) => cancelAttachmentStage(apiBase, 's1'),
  ],
  [
    'attachment capability (getJson)',
    (apiBase) => getAttachmentStagingCapability(apiBase),
  ],
  [
    'orchestration command (authenticatedFetch)',
    (apiBase) =>
      dispatchOrchestrationCommand(
        { type: 'session.interrupt', sessionId: 's1' } as never,
        apiBase,
      ),
  ],
  [
    'steer command (authenticatedFetch)',
    (apiBase) => steerTurn(apiBase, { threadId: 't1', input: 'go' } as never),
  ],
  [
    'chat stream (authenticatedFetch)',
    (apiBase) =>
      streamConversationTurn({
        agentSlug: 'writer',
        content: 'hello',
        onStreamEvent: () => undefined,
        apiBase,
      } as never),
  ],
];

async function refusalOf(call: () => Promise<unknown>): Promise<ChatHttpError> {
  const error = await call().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ChatHttpError);
  return error as ChatHttpError;
}

/** A marked success, as any ordinary read from a current Station is. */
async function seeMarkedSuccess(apiBase: string): Promise<void> {
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ success: true, data: [] }, 200, true),
  );
  await getJson(`${apiBase}/api/anything`);
}

describe("#2842 Station's own refusal is identified by the response marker", () => {
  beforeEach(() => {
    resetStationEnvelopeObservations();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  describe.each(producers)('%s', (_name, call) => {
    it('a marked refusal is Station’s own, with its status and code', async () => {
      vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, true));

      const error = await refusalOf(() => call(STATION));

      expect(error.stationEnvelope).toBe(true);
      expect(error).toMatchObject({ status: 403, code: 'refused' });
    });

    it('an unmarked refusal from a Station that has never sent the marker falls back to its shape', async () => {
      vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, false));

      const error = await refusalOf(() => call(OLD_STATION));

      expect(error.stationEnvelope).toBe(true);
    });

    it('an unmarked refusal in Station’s shape is not Station’s once this Station has sent the marker', async () => {
      await seeMarkedSuccess(STATION);
      vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, false));

      const error = await refusalOf(() => call(STATION));

      expect(error.stationEnvelope).toBe(false);
      // What the gateway said is kept; only its authorship is denied.
      expect(error.status).toBe(403);
    });
  });

  it("the runtime's auth-refusal shape without the marker is a gateway's once the marker is known", async () => {
    await seeMarkedSuccess(STATION);
    vi.mocked(fetch).mockResolvedValue(json(AUTH_REFUSAL, 403, false));

    const error = await refusalOf(() => sendExecutionMessage(STATION, message));

    expect(error.stationEnvelope).toBe(false);
  });

  it('a marked refusal teaches the origin as well as a marked success does', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(REFUSAL, 403, true));
    await refusalOf(() => sendExecutionMessage(STATION, message));
    vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, false));

    const error = await refusalOf(() => sendExecutionMessage(STATION, message));

    expect(error.stationEnvelope).toBe(false);
  });

  it('one Station sending the marker says nothing about another origin', async () => {
    await seeMarkedSuccess(STATION);
    vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, false));

    const error = await refusalOf(() =>
      sendExecutionMessage(OLD_STATION, message),
    );

    expect(error.stationEnvelope).toBe(true);
  });

  it('the marker never makes a body that is not an envelope Station’s answer', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Forbidden</html>', {
        status: 403,
        headers: { [MARKER]: '1' },
      }),
    );
    expect(
      (await refusalOf(() => sendExecutionMessage(STATION, message)))
        .stationEnvelope,
    ).toBe(false);

    vi.mocked(fetch).mockResolvedValue(
      json({ message: 'Forbidden' }, 403, true),
    );
    expect(
      (await refusalOf(() => sendExecutionMessage(STATION, message)))
        .stationEnvelope,
    ).toBe(false);
  });

  it.each(['0', 'true', '1, 1', ''])(
    'a marker header whose value is %j is not the marker',
    async (value) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', [MARKER]: value },
        }),
      );
      await getJson(`${STATION}/api/anything`);
      vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, false));

      const error = await refusalOf(() =>
        sendExecutionMessage(STATION, message),
      );

      // The origin was never learned, so the shape still decides.
      expect(error.stationEnvelope).toBe(true);
    },
  );

  it('a native transport response, which has no url, is attributed to the request’s origin', async () => {
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      void init;
      return transport.mock.calls.length === 1
        ? json({ success: true, data: [] }, 200, true)
        : json(REFUSAL, 403, false);
    });
    setClientCredentialResolver(() => ({
      origin: STATION,
      transport: transport as never,
    }));

    await getJson(`${STATION}/api/anything`);
    const error = await refusalOf(() => sendExecutionMessage(STATION, message));

    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(error.stationEnvelope).toBe(false);
  });

  describe('the attachment upload, through the XHR transport', () => {
    /** A browser XHR answering one upload with a fixed status and headers. */
    function stubXhr(status: number, body: unknown, headers: string): void {
      class FakeXhr {
        status = 0;
        responseText = '';
        upload = { onprogress: null };
        onerror: (() => void) | null = null;
        onabort: (() => void) | null = null;
        onload: (() => void) | null = null;
        open() {}
        setRequestHeader() {}
        abort() {}
        getAllResponseHeaders() {
          return headers;
        }
        send() {
          this.status = status;
          this.responseText = JSON.stringify(body);
          queueMicrotask(() => this.onload?.());
        }
      }
      vi.stubGlobal('XMLHttpRequest', FakeXhr);
    }
    const upload = () =>
      uploadAttachmentStage(
        STATION,
        { stageId: 's1', uploadGrant: 'grant' } as never,
        'data:text/plain;base64,aGk=',
        { transport: xhrAttachmentStageUpload },
      );

    it('a gateway JSON 413 without the marker is not Station’s after a marked success', async () => {
      await seeMarkedSuccess(STATION);
      stubXhr(
        413,
        { success: false, error: 'Request entity too large' },
        'content-type: application/json\r\n',
      );

      const error = await refusalOf(upload);

      expect(error.status).toBe(413);
      expect(error.stationEnvelope).toBe(false);
    });

    it('a marked 413 from Station is Station’s own', async () => {
      await seeMarkedSuccess(STATION);
      stubXhr(
        413,
        { success: false, error: 'Attachment too large', code: 'too_large' },
        `content-type: application/json\r\n${MARKER}: 1\r\n`,
      );

      const error = await refusalOf(upload);

      expect(error).toMatchObject({ status: 413, code: 'too_large' });
      expect(error.stationEnvelope).toBe(true);
    });
  });

  it('a credential change for an origin forgets what it said', async () => {
    await seeMarkedSuccess(STATION);
    notifyCredentialChanged(STATION);
    vi.mocked(fetch).mockResolvedValue(json(REFUSAL, 403, false));

    const error = await refusalOf(() => sendExecutionMessage(STATION, message));

    // Read by shape again until the origin sends the marker anew.
    expect(error.stationEnvelope).toBe(true);
  });

  it('switching to another Station forgets every origin; setting the same base does not', async () => {
    _setApiBase(STATION);
    await seeMarkedSuccess(STATION);
    _setApiBase(STATION);
    // A fresh Response per call: a body can be read once.
    vi.mocked(fetch).mockImplementation(async () => json(REFUSAL, 403, false));
    expect(
      (await refusalOf(() => sendExecutionMessage(STATION, message)))
        .stationEnvelope,
    ).toBe(false);

    _setApiBase(OLD_STATION);

    expect(
      (await refusalOf(() => sendExecutionMessage(STATION, message)))
        .stationEnvelope,
    ).toBe(true);
  });

  it('a response that never passed a request seam is attributed by its own url', () => {
    observeStationResponse(`${STATION}/api/x`, {
      headers: new Headers({ [MARKER]: '1' }),
    });

    const unmarked = (url: string) => ({ url, headers: new Headers() });
    expect(isStationAnswer(unmarked(`${STATION}/api/y`), REFUSAL)).toBe(false);
    expect(isStationAnswer(unmarked(`${OLD_STATION}/api/y`), REFUSAL)).toBe(
      true,
    );
    // No origin at all: nothing is known, so the shape decides.
    expect(isStationAnswer({ headers: new Headers() }, REFUSAL)).toBe(true);
    expect(isStationAnswer({}, REFUSAL)).toBe(true);
    expect(isStationAnswer({}, '<html>')).toBe(false);
  });

  it('an origin that sends the marker again is the last forgotten, not the first', () => {
    const marked = { headers: new Headers({ [MARKER]: '1' }) };
    const unmarked = (origin: string) => ({
      url: `${origin}/api/y`,
      headers: new Headers(),
    });
    const origin = (index: number) => `http://station-${index}.test`;
    const LIMIT = 64;

    for (let index = 0; index < LIMIT; index += 1) {
      observeStationResponse(`${origin(index)}/api/x`, marked);
    }
    // The oldest origin answers again, so it is now the most recent.
    observeStationResponse(`${origin(0)}/api/x`, marked);
    observeStationResponse(`${origin(LIMIT)}/api/x`, marked);

    expect(isStationAnswer(unmarked(origin(0)), REFUSAL)).toBe(false);
    // The origin seen longest ago is now the second one, and it went.
    expect(isStationAnswer(unmarked(origin(1)), REFUSAL)).toBe(true);
  });

  it('remembers a bounded number of origins; a forgotten one is read by shape again', () => {
    const marked = { headers: new Headers({ [MARKER]: '1' }) };
    const unmarked = (origin: string) => ({
      url: `${origin}/api/y`,
      headers: new Headers(),
    });
    const origin = (index: number) => `http://station-${index}.test`;
    const LIMIT = 64;

    for (let index = 0; index < LIMIT; index += 1) {
      observeStationResponse(`${origin(index)}/api/x`, marked);
    }
    expect(isStationAnswer(unmarked(origin(0)), REFUSAL)).toBe(false);

    // One past the limit: the origin seen longest ago is forgotten.
    observeStationResponse(`${origin(LIMIT)}/api/x`, marked);
    expect(isStationAnswer(unmarked(origin(0)), REFUSAL)).toBe(true);
    expect(isStationAnswer(unmarked(origin(1)), REFUSAL)).toBe(false);
    expect(isStationAnswer(unmarked(origin(LIMIT)), REFUSAL)).toBe(false);
  });
});
