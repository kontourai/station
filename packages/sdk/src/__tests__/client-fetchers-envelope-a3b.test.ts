import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAccountOperation } from '../client/account-authentication';
import {
  ActionOperationProtocolError,
  cancelActionOperation,
  fetchActionOperations,
  watchActionOperations,
} from '../client/action-operations';
import {
  AnswerBasisRequestError,
  getAnswerBasis,
} from '../client/answer-basis';
import {
  AnswerNarrativeBindingRequestError,
  getAnswerNarrativeTarget,
  removeAnswerNarrative,
} from '../client/answer-narrative-binding';
import {
  AnswerSupportRequestError,
  listAnswerSupportBundles,
} from '../client/answer-support';
import {
  ApplicationSessionClient,
  createApplicationSessionKey,
} from '../client/application-session';
import { cancelAttachmentStage } from '../client/attachment-staging';
import { getAuthorityObservation } from '../client/authority-observation';
import {
  BoardProvenanceRefusedError,
  BoardResponseError,
  getBoard,
} from '../client/board';
import { ChatHttpError } from '../client/chatHttpError';
import { previewCheckpointRestore } from '../client/checkpoint-restore';
import { getConversationPullRequestLinks } from '../client/conversation-pull-request-links';
import { DelegationApiError, delegateTask } from '../client/delegations';
import { fetchFleetRoutingReceipts } from '../client/fleet-routing';
import {
  FlowGateEvaluationRequestError,
  getTaskFlowGateEvaluations,
} from '../client/flow-gate-evaluations';
import { StationHttpError, setClientCredentialResolver } from '../client/http';
import { observeLearningSource } from '../client/learning-source';
import {
  fetchLiveActivity,
  LiveActivityProtocolError,
} from '../client/live-activity';
import { deletePersonalLayout } from '../client/personal-layouts';
import { deleteProjectLayout } from '../client/projects';
import { getPullRequestReview } from '../client/pull-request-review';
import { getAssistantQuoteSource } from '../client/quote-source';
import { listRuns } from '../client/runs';
import { fetchExistingSetupImportSources } from '../client/setup-imports';
import { resetStationEnvelopeObservations } from '../client/station-envelope';

/**
 * #2708 A-3b: the last client fetchers that built their own error from a
 * response now go through the envelope helper. Each row drives a real fetcher
 * over a stubbed `fetch` and asserts the thrown error's type and fields, so a
 * caller can branch on them instead of on the message.
 *
 * The bodies are the two Station actually sends: the shared validation
 * middleware's refusal and a typed refusal with a machine `code`.
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

function jsonResponse(
  body: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function htmlResponse(status: number): Response {
  return new Response('<html>Bad gateway</html>', { status });
}

type ErrorClass = abstract new (...args: never) => Error;
type Row = readonly [string, () => Promise<unknown>, ErrorClass];

const SCOPE = { apiBase: API, authorityKey: 'authority-1' };
const pullRequest = {
  provider: 'gitlab',
  host: 'forge.test',
  owner: 'group',
  repository: 'repo',
  ref: '17',
  project: 'project',
  repositoryRootHint: '/worktree',
};

/** Fetchers whose refusal is read out in full: words, details and code. */
const readable: ReadonlyArray<Row> = [
  [
    'account operation',
    () => runAccountOperation(API, '/sign-in', {}),
    StationHttpError,
  ],
  [
    'application session',
    async () =>
      new ApplicationSessionClient(
        API,
        'station-1',
        'http://app.test',
        {},
        await createApplicationSessionKey(),
      ).capabilities(),
    StationHttpError,
  ],
  ['attachment stage', () => cancelAttachmentStage(API, 's1'), ChatHttpError],
  [
    'board',
    () => getBoard(API, { kind: 'project', id: 'p1' } as never),
    BoardResponseError,
  ],
  [
    'checkpoint restore',
    () => previewCheckpointRestore(API, 'thread-1', 'turn-1', SCOPE),
    StationHttpError,
  ],
  [
    'conversation pull requests',
    () => getConversationPullRequestLinks(API, 'c1'),
    StationHttpError,
  ],
  ['delegation', () => delegateTask(API, {} as never), DelegationApiError],
  [
    'fleet routing receipts',
    () => fetchFleetRoutingReceipts(API),
    StationHttpError,
  ],
  [
    'learning source',
    () =>
      observeLearningSource(API, {
        rootId: 'root',
        recordId: 'record',
        rootIdentity: 'identity',
      }),
    StationHttpError,
  ],
  [
    'personal Board delete',
    () => deletePersonalLayout(API, 'b1'),
    StationHttpError,
  ],
  [
    'Project layout delete',
    () => deleteProjectLayout(API, 'p1', 'l1'),
    StationHttpError,
  ],
  ['runs', () => listRuns(API), StationHttpError],
  [
    'setup import',
    () => fetchExistingSetupImportSources(API),
    StationHttpError,
  ],
  [
    'answer support',
    () => listAnswerSupportBundles(API, 't1', 'r1'),
    AnswerSupportRequestError,
  ],
  [
    'action operation cancellation',
    () => cancelActionOperation(API, 'op1'),
    ActionOperationProtocolError,
  ],
];

/**
 * Fetchers that withhold the route's words on purpose: the message is the
 * client's own, and only the status, `code` and `Retry-After` cross.
 */
const opaque: ReadonlyArray<readonly [...Row, (status: number) => string]> = [
  [
    'answer basis',
    () => getAnswerBasis(API, 's1', 't1'),
    AnswerBasisRequestError,
    () => 'Answer basis unavailable',
  ],
  [
    'answer narrative read',
    () => getAnswerNarrativeTarget(API, 's1', 't1'),
    AnswerNarrativeBindingRequestError,
    () => 'Answer narrative binding unavailable',
  ],
  [
    'answer narrative removal',
    () => removeAnswerNarrative(API, 's1', 't1', 1),
    AnswerNarrativeBindingRequestError,
    () => 'Answer narrative binding unavailable',
  ],
  [
    'gate evaluations',
    () => getTaskFlowGateEvaluations(API, 't1'),
    FlowGateEvaluationRequestError,
    () => 'Gate evaluation unavailable',
  ],
  [
    'quote source',
    () => getAssistantQuoteSource(API, 's1', 't1'),
    StationHttpError,
    () => 'Quote source unavailable',
  ],
  [
    'authority observation',
    () => getAuthorityObservation(API),
    StationHttpError,
    (status) =>
      `This Station refused the authority observation (HTTP ${status}).`,
  ],
  [
    'live activity',
    () => fetchLiveActivity(API),
    LiveActivityProtocolError,
    (status) => `Live activity request failed (${status})`,
  ],
  [
    'action operation list',
    () => fetchActionOperations(API),
    ActionOperationProtocolError,
    () => 'Action operation request failed',
  ],
  [
    'action operation watch',
    () => watchActionOperations(API),
    ActionOperationProtocolError,
    () => 'Action operation watch failed',
  ],
];

/** Fetchers whose refusal with a body that is not JSON keeps its status. */
const keepsStatusWithoutJson: ReadonlyArray<Row> = [
  ...readable
    .filter(
      ([name]) =>
        // This one reports an unreadable body as a protocol failure first.
        name !== 'action operation cancellation',
    )
    .map(([name, call, type]) =>
      // A page is not Station's delegation refusal, so it is not typed as one.
      name === 'delegation'
        ? ([name, call, StationHttpError] as const)
        : ([name, call, type] as const),
    ),
  ...opaque
    .filter(
      ([name]) =>
        name !== 'live activity' && !name.startsWith('action operation'),
    )
    .map(([name, call, type]) => [name, call, type] as const),
];

describe('#2708 A-3b fetchers throw typed refusals', () => {
  beforeEach(() => {
    resetStationEnvelopeObservations();
    vi.stubGlobal('fetch', vi.fn());
    setClientCredentialResolver(() => ({
      origin: API,
      requestAuthority: { ...SCOPE, isCurrent: () => true },
    }));
  });
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it.each(readable)(
    '%s: a validation refusal keeps status and details, naming each field',
    async (_name, call, type) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(VALIDATION, 400));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        status: 400,
        details: FIELDS,
        message: 'Validation failed: name Required',
      });
    },
  );

  it.each(readable)(
    '%s: a typed refusal keeps its status, code, words and Retry-After',
    async (_name, call, type) => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(GUARD, 403, { 'retry-after': '7' }),
      );

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({
        status: 403,
        code: 'station_control_caller_required',
        message: 'This action needs a verified calling session.',
        retryAfterMs: 7000,
      });
    },
  );

  it.each(opaque)(
    '%s: a refusal keeps status, code and Retry-After under the client’s own sentence',
    async (_name, call, type, sentence) => {
      for (const body of [GUARD, VALIDATION]) {
        vi.mocked(fetch).mockResolvedValue(
          jsonResponse(body, 403, { 'retry-after': '7' }),
        );

        const error = await call().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(type);
        expect(error).toMatchObject({
          status: 403,
          message: sentence(403),
          retryAfterMs: 7000,
        });
        expect((error as { code?: string }).code).toBe(
          (body as { code?: string }).code,
        );
        // Nothing the route said crosses: no words, and no details.
        expect((error as { details?: unknown }).details).toBeUndefined();
      }
    },
  );

  it.each(keepsStatusWithoutJson)(
    '%s: a refusal whose body is not JSON keeps its status, with no code',
    async (_name, call, type) => {
      vi.mocked(fetch).mockResolvedValue(htmlResponse(502));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ status: 502 });
      expect((error as { code?: string }).code).toBeUndefined();
    },
  );

  it.each([
    ['personal Board delete', () => deletePersonalLayout(API, 'b1')],
    ['Project layout delete', () => deleteProjectLayout(API, 'p1', 'l1')],
    ['setup import', () => fetchExistingSetupImportSources(API)],
    ['fleet routing receipts', () => fetchFleetRoutingReceipts(API)],
    ['runs', () => listRuns(API)],
  ] as const)(
    '%s: a 200 success:false is a refusal with its observed status and code',
    async (_name, call) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(GUARD, 200));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StationHttpError);
      expect(error).toMatchObject({
        status: 200,
        code: 'station_control_caller_required',
      });
    },
  );

  it('authority observation: a 401 keeps its own sentence, with status and code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: { code: 'authentication_required' } }, 401),
    );

    const error = await getAuthorityObservation(API).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StationHttpError);
    expect(error).toMatchObject({
      status: 401,
      code: 'authentication_required',
      message: 'This Station did not accept the presented credential.',
    });
  });

  it('board: the provenance refusal keeps its class, observed status and details', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          success: false,
          code: 'board_provenance_refused',
          error: 'This claim cannot be pinned.',
          details: { claim: 'c1' },
        },
        422,
      ),
    );

    const error = await getBoard(API, {
      kind: 'project',
      id: 'p1',
    } as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BoardProvenanceRefusedError);
    expect(error).toBeInstanceOf(BoardResponseError);
    expect(error).toMatchObject({
      name: 'BoardProvenanceRefusedError',
      status: 422,
      code: 'board_provenance_refused',
      message: 'This claim cannot be pinned.',
      details: { claim: 'c1' },
    });
  });

  it('board: the positional constructors still build the same errors', () => {
    expect(new BoardResponseError(409, 'busy', 'board_busy')).toMatchObject({
      name: 'BoardResponseError',
      status: 409,
      message: 'busy',
      code: 'board_busy',
    });
    expect(
      new BoardResponseError(500, 'failed', undefined).code,
    ).toBeUndefined();
    expect(new BoardProvenanceRefusedError('refused')).toMatchObject({
      status: 422,
      code: 'board_provenance_refused',
      message: 'refused',
    });
  });

  it('delegation: the refusal keeps the body’s retryable flag beside the helper’s fields', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        { ...GUARD, retryable: true, details: { engine: 'e1' } },
        409,
      ),
    );

    const error = await delegateTask(API, {} as never).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DelegationApiError);
    expect(error).toMatchObject({
      name: 'DelegationApiError',
      status: 409,
      code: 'station_control_caller_required',
      retryable: true,
      details: { engine: 'e1' },
    });
  });

  it('delegation: the positional constructor still builds the same error, with no status', () => {
    const error = new DelegationApiError('no', 'refused', false, { a: 1 });

    expect(error).toMatchObject({
      message: 'no',
      code: 'refused',
      retryable: false,
      details: { a: 1 },
    });
    expect(error.status).toBeUndefined();
    expect(new DelegationApiError('no').code).toBeUndefined();
  });

  it('answer support: the positional constructor still builds the same error', () => {
    const error = new AnswerSupportRequestError('gone', 404);

    expect(error).toMatchObject({ message: 'gone', status: 404 });
    expect(error.code).toBeUndefined();
  });

  it.each([
    [AnswerBasisRequestError, 'Answer basis unavailable'],
    [
      AnswerNarrativeBindingRequestError,
      'Answer narrative binding unavailable',
    ],
    [FlowGateEvaluationRequestError, 'Gate evaluation unavailable'],
  ] as const)(
    '%o: a bare status still builds the same error, and a transport failure is status 0',
    (type, sentence) => {
      const error = new type(404);
      expect(error).toMatchObject({ status: 404, message: sentence });
      expect(error.code).toBeUndefined();
    },
  );

  it.each([
    ['answer basis', () => getAnswerBasis(API, 's1', 't1')],
    ['answer narrative', () => getAnswerNarrativeTarget(API, 's1', 't1')],
    ['gate evaluations', () => getTaskFlowGateEvaluations(API, 't1')],
  ] as const)(
    '%s: a transport failure observed no response: status 0, no code',
    async (_name, call) => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toMatchObject({ status: 0 });
      expect((error as { code?: string }).code).toBeUndefined();
    },
  );

  it.each([
    [ActionOperationProtocolError, 'ActionOperationProtocolError'],
    [LiveActivityProtocolError, 'LiveActivityProtocolError'],
  ] as const)(
    '%o: a protocol message alone carries no refusal fields',
    (type, name) => {
      const error = new type('response is invalid');
      expect(error).toMatchObject({ name, message: 'response is invalid' });
      expect(error.status).toBeUndefined();
      expect(error.code).toBeUndefined();
    },
  );

  it('pull request review: the refusal names its reason and keeps status, code and details', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          success: false,
          code: 'checkout_unresolved',
          error: 'Checkout forge host is ambiguous or unsupported.',
        },
        404,
      ),
    );

    const error = await getPullRequestReview(API, pullRequest, {
      requestScope: SCOPE,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StationHttpError);
    expect(error).toMatchObject({
      status: 404,
      code: 'checkout_unresolved',
      message:
        'Pull request review unavailable: Checkout forge host is ambiguous or unsupported.',
    });
  });

  it('pull request review: a proxy page keeps its status and the refresh sentence', async () => {
    vi.mocked(fetch).mockResolvedValue(htmlResponse(502));

    const error = await getPullRequestReview(API, pullRequest, {
      requestScope: SCOPE,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StationHttpError);
    expect(error).toMatchObject({
      status: 502,
      message:
        'Pull request review unavailable. Refresh to inspect current provider state.',
    });
  });

  it('pull request review: a 2xx that is not an available result is refused without a reason', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: true, data: {} }, 200),
    );

    const error = await getPullRequestReview(API, pullRequest, {
      requestScope: SCOPE,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 200,
      message:
        'Pull request review unavailable. Refresh to inspect current provider state.',
    });
  });
});
