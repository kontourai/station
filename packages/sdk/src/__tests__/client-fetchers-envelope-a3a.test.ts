import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentDetailed,
  createAgentRaw,
  deleteAgentRaw,
  fetchAgentCatalog,
  getAgent,
  materializeEngineAgent,
  updateAgentRaw,
} from '../client/agents';
import { ChatHttpError } from '../client/chatHttpError';
import {
  cancelConversationContextBoundary,
  continueExecutionMessage,
  ForegroundMessageIndeterminateError,
  getConversationContextBoundaryStatus,
  getConversationHandoffStatus,
  handoffExecutionMessage,
  reserveConversationContextBoundary,
} from '../client/execution';
import { StationHttpError, setClientCredentialResolver } from '../client/http';
import { getInputReplyContext } from '../client/input-reply';
import {
  appendProjectTaskRoomHumanMessage,
  discoverProjectTaskRoom,
  ProjectTaskRoomProtocolError,
} from '../client/project-task-rooms';
import { sendExecutionMessage } from '../client/send-execution-message';
import {
  getSessionInventory,
  SessionInventoryRequestError,
} from '../client/session-inventory';
import {
  listSessionOutputs,
  SessionOutputsRequestError,
} from '../client/session-outputs';
import { getTaskBasis, TaskBasisRequestError } from '../client/task-basis';
import {
  createTaskOutputClient,
  deleteTaskOutputClient,
  downloadTaskOutputContent,
  getTaskOutput,
  keepDeclaredTaskOutput,
  listTaskOutputs,
} from '../client/task-outputs';
import {
  getTaskToolResultReferences,
  TaskToolResultRequestError,
} from '../client/task-tool-results';
import {
  getTaskUserInputReferences,
  TaskUserInputReferenceRequestError,
} from '../client/task-user-input-references';

/**
 * #2708 A-3a: the execution, agents, task and session fetchers moved onto
 * the envelope helper. The refusal bodies are the shapes Station's real
 * writers produce: the shared zod middleware's validation refusal
 * (`schema-validation.ts`: `{success:false, error:'Validation failed',
 * details:{formErrors, fieldErrors}}`) and the station-control authority
 * guard's typed refusal (`stationControlRefusalBody`: `{success:false, code,
 * error}`).
 */
const API = 'http://example.test';
const FIELDS = { formErrors: [], fieldErrors: { name: ['Required'] } };
const VALIDATION = {
  success: false,
  error: 'Validation failed',
  details: FIELDS,
};
const GUARD = {
  success: false,
  code: 'station_control_caller_required',
  error: 'This action needs a verified calling session.',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(status: number, headers?: HeadersInit): Response {
  return new Response('<html>Bad gateway</html>', { status, headers });
}

type ErrorClass = abstract new (...args: never) => Error;

const message = {
  agentId: 'writer',
  message: 'hello',
  idempotencyKey: 'k1',
} as never;

/** Fetchers whose refusal is read out in full: words, details and code. */
const readableFetchers: ReadonlyArray<
  readonly [string, () => Promise<unknown>, ErrorClass]
> = [
  ['agents: fetchAgentCatalog', () => fetchAgentCatalog(API), StationHttpError],
  ['agents: getAgent', () => getAgent(API, 'writer'), StationHttpError],
  [
    'agents: createAgentDetailed',
    () => createAgentDetailed(API, { slug: 'w' }),
    StationHttpError,
  ],
  [
    'agents: createAgentRaw',
    () => createAgentRaw(API, { slug: 'w' }),
    StationHttpError,
  ],
  [
    'agents: materializeEngineAgent',
    () => materializeEngineAgent(API, 'codex'),
    StationHttpError,
  ],
  [
    'agents: updateAgentRaw',
    () => updateAgentRaw(API, 'w', { name: '' }),
    StationHttpError,
  ],
  ['agents: deleteAgentRaw', () => deleteAgentRaw(API, 'w'), StationHttpError],
  [
    'execution: sendExecutionMessage',
    () => sendExecutionMessage(API, message),
    ChatHttpError,
  ],
  [
    'execution: continueExecutionMessage',
    () => continueExecutionMessage(API, 'c1', message),
    ChatHttpError,
  ],
  [
    'execution: handoffExecutionMessage',
    () => handoffExecutionMessage(API, 'c1', message),
    ChatHttpError,
  ],
  [
    'execution: getConversationHandoffStatus',
    () => getConversationHandoffStatus(API, 'c1', 'k1'),
    ChatHttpError,
  ],
  [
    'execution: reserveConversationContextBoundary',
    () =>
      reserveConversationContextBoundary(API, 'c1', {
        policy: 'fresh',
        expectedCurrentSessionId: 's1',
        idempotencyKey: 'k1',
      } as never),
    ChatHttpError,
  ],
  [
    'execution: getConversationContextBoundaryStatus',
    () => getConversationContextBoundaryStatus(API, 'c1', 'k1'),
    ChatHttpError,
  ],
  [
    'execution: cancelConversationContextBoundary',
    () => cancelConversationContextBoundary(API, 'c1', 'k1'),
    ChatHttpError,
  ],
  [
    'task outputs: listTaskOutputs',
    () => listTaskOutputs(API, 't1'),
    StationHttpError,
  ],
  [
    'task outputs: getTaskOutput',
    () => getTaskOutput(API, 't1', 'o1'),
    StationHttpError,
  ],
  [
    'task outputs: createTaskOutputClient',
    () => createTaskOutputClient(API, 't1', { title: 'x' } as never),
    StationHttpError,
  ],
  [
    'task outputs: keepDeclaredTaskOutput',
    () => keepDeclaredTaskOutput(API, 't1', 's1', 'e1', { operationId: 'op1' }),
    StationHttpError,
  ],
  [
    'task outputs: deleteTaskOutputClient',
    () => deleteTaskOutputClient(API, 't1', 'o1'),
    StationHttpError,
  ],
  [
    'task outputs: downloadTaskOutputContent',
    () => downloadTaskOutputContent(API, 't1', 'o1'),
    StationHttpError,
  ],
  [
    'task rooms: discoverProjectTaskRoom',
    () => discoverProjectTaskRoom(API, 't1'),
    ProjectTaskRoomProtocolError,
  ],
  [
    'task rooms: appendProjectTaskRoomHumanMessage',
    () =>
      appendProjectTaskRoomHumanMessage(API, {
        taskId: 't1',
        proposalId: 'p1',
        text: 'hi',
      }),
    ProjectTaskRoomProtocolError,
  ],
];

/**
 * Fetchers that deliberately withhold what the route said (protected
 * references and the input-reply lookup): status, code and Retry-After
 * cross; the words and details never do.
 */
const opaqueFetchers: ReadonlyArray<
  readonly [string, () => Promise<unknown>, ErrorClass, string]
> = [
  [
    'task tool results: getTaskToolResultReferences',
    () => getTaskToolResultReferences(API, 't1'),
    TaskToolResultRequestError,
    'Tool result unavailable',
  ],
  [
    'task user input: getTaskUserInputReferences',
    () => getTaskUserInputReferences(API, 't1'),
    TaskUserInputReferenceRequestError,
    'User input reference unavailable',
  ],
  [
    'task basis: getTaskBasis',
    () => getTaskBasis(API, 't1'),
    TaskBasisRequestError,
    'Task basis unavailable',
  ],
  [
    'session outputs: listSessionOutputs',
    () => listSessionOutputs(API, 's1'),
    SessionOutputsRequestError,
    'Session outputs unavailable',
  ],
  [
    'session inventory: getSessionInventory',
    () => getSessionInventory(API, { kind: 'whole-session', sessionId: 's1' }),
    SessionInventoryRequestError,
    'Session inventory unavailable',
  ],
  [
    'input reply: getInputReplyContext',
    () =>
      getInputReplyContext(API, {
        threadId: 't1',
        requestId: 'r1',
        requestEventId: 'e1',
      } as never),
    StationHttpError,
    'Input request unavailable',
  ],
];

describe('#2708 A-3a fetchers keep what Station answered', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it.each(readableFetchers)(
    '%s: a validation refusal keeps status and details, naming each field',
    async (_name, call, type) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(VALIDATION, 400));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({
        status: 400,
        details: FIELDS,
        message: 'Validation failed: name Required',
      });
    },
  );

  it.each(readableFetchers)(
    '%s: an authority refusal keeps its typed code',
    async (_name, call, type) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(GUARD, 403));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({
        status: 403,
        code: 'station_control_caller_required',
        message: 'This action needs a verified calling session.',
      });
    },
  );

  it.each(readableFetchers)(
    '%s: a non-JSON 502 keeps its status and Retry-After',
    async (_name, call, type) => {
      vi.mocked(fetch).mockResolvedValue(
        htmlResponse(502, { 'retry-after': '3' }),
      );

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ status: 502, retryAfterMs: 3000 });
    },
  );

  it.each(opaqueFetchers)(
    '%s: a refusal keeps status, code and Retry-After but not its words',
    async (_name, call, type, fixed) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            ...GUARD,
            error: 'secret path /home/someone/private',
            details: FIELDS,
          }),
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      );

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({
        status: 429,
        code: 'station_control_caller_required',
        retryAfterMs: 2000,
        message: fixed,
      });
      expect((error as { details?: unknown }).details).toBeUndefined();
    },
  );

  it.each(opaqueFetchers)(
    '%s: a non-JSON 502 keeps its status',
    async (_name, call, type, fixed) => {
      vi.mocked(fetch).mockResolvedValue(htmlResponse(502));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ status: 502, message: fixed });
    },
  );

  // An unreadable 2xx is a protocol failure: no refusal status to report.
  it.each([
    ['agents: getAgent', () => getAgent(API, 'writer')],
    ['agents: deleteAgentRaw', () => deleteAgentRaw(API, 'w')],
    [
      'execution: getConversationHandoffStatus',
      () => getConversationHandoffStatus(API, 'c1', 'k1'),
    ],
    ['task outputs: listTaskOutputs', () => listTaskOutputs(API, 't1')],
  ] as const)(
    '%s: an unreadable 2xx stays a plain Error',
    async (_name, call) => {
      vi.mocked(fetch).mockResolvedValue(htmlResponse(200));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(StationHttpError);
    },
  );

  it('task rooms: an unreadable 2xx stays a protocol error with no status', async () => {
    vi.mocked(fetch).mockResolvedValue(htmlResponse(200));

    const error = await discoverProjectTaskRoom(API, 't1').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProjectTaskRoomProtocolError);
    expect((error as ProjectTaskRoomProtocolError).status).toBeUndefined();
  });

  it('execution: a 200 success:false keeps its observed status and code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: false, code: 'not_ready', error: 'no' }, 200),
    );

    const error = await getConversationHandoffStatus(API, 'c1', 'k1').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ChatHttpError);
    expect(error).toMatchObject({ status: 200, code: 'not_ready' });
  });

  // A transport failure observed no response: status 0, no code.
  it('task basis: a transport failure is status 0 with no code', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

    const error = await getTaskBasis(API, 't1').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TaskBasisRequestError);
    expect(error).toMatchObject({ status: 0 });
    expect((error as TaskBasisRequestError).code).toBeUndefined();
  });

  // #2708 A-3a review: a chat refusal says whether Station answered it, so
  // a caller never treats a proxy's page as a definitive refusal.
  it.each([
    ['a Station refusal', true, () => jsonResponse(GUARD, 403)],
    ['a Station validation refusal', true, () => jsonResponse(VALIDATION, 400)],
    [
      "the runtime's auth refusal",
      true,
      () => jsonResponse({ error: { code: 'insufficient_scope' } }, 403),
    ],
    ['a proxy HTML page', false, () => htmlResponse(403)],
    [
      'JSON that is not an envelope',
      false,
      () => jsonResponse({ message: 'Forbidden' }, 403),
    ],
  ] as const)(
    'execution: %s is marked stationEnvelope=%s',
    async (_name, expected, answer) => {
      for (const call of [
        () => sendExecutionMessage(API, message),
        () => getConversationHandoffStatus(API, 'c1', 'k1'),
      ]) {
        vi.mocked(fetch).mockResolvedValue(answer());
        const error = await call().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ChatHttpError);
        expect((error as ChatHttpError).stationEnvelope).toBe(expected);
      }
    },
  );

  it('ChatHttpError positional form is a Station answer unless told not', () => {
    expect(new ChatHttpError(400, 'no').stationEnvelope).toBe(true);
    expect(
      new ChatHttpError(403, undefined, undefined, false).stationEnvelope,
    ).toBe(false);
  });

  it('ChatHttpError keeps its positional form and is a StationHttpError', () => {
    const error = new ChatHttpError(409, 'busy', 'turn_in_progress');

    expect(error).toBeInstanceOf(StationHttpError);
    expect(error).toMatchObject({
      status: 409,
      code: 'turn_in_progress',
      serverMessage: 'busy',
      message: 'busy',
      name: 'ChatHttpError',
    });
    expect(new ChatHttpError(502).message).toBe('HTTP 502');
  });

  it('ForegroundMessageIndeterminateError keeps its positional form', () => {
    const error = new ForegroundMessageIndeterminateError(
      409,
      'unknown',
      {} as never,
    );

    expect(error).toMatchObject({
      status: 409,
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });
});
