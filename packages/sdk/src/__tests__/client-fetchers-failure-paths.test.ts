import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgent } from '../client/agents';
import {
  listAgentConversationPage,
  listAgentConversations,
  listConversationInventory,
} from '../client/conversations';
import { StationHttpError } from '../client/http';
import { listIntegrations } from '../client/integrations';
import {
  getOrchestrationSessionEventWindow,
  getProviderCommands,
  getSessionFlowRun,
  respondToRequest,
} from '../client/orchestration';
import { createProject, listProjects } from '../client/projects';
import { fetchSystemSkills, importSkills } from '../client/skills';

/**
 * #167 iteration-2 (H1 sweep): one representative failure-path test per
 * `client/**` fetcher family, mirroring the shape of `scheduler.test.ts`'s
 * (Wave 3) and `station-control-operations-tools.test.ts`'s (Wave 3)
 * characterization tests — mock a non-2xx response carrying a
 * `{success:false, error}` body and assert the fetcher's thrown error
 * carries the server's `error` text rather than a generic status message.
 * `runs.ts`'s equivalent test lives in `scheduler.test.ts` (it is exercised
 * through `runsQueries.list()`, the only pre-#167 consumer); `scheduler.ts`'s
 * own fetchers already have failure-path coverage via
 * `src-server/tools/__tests__/station-control-operations-tools.test.ts`.
 */
function nonOkJsonResponse(body: unknown, status = 500): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as Response;
}

describe('client/** fetcher failure paths (#167 iteration-2)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('skills import dispatches one POST with the selected markdown files', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        data: {
          imported: 1,
          results: [
            {
              filename: 'release-check.md',
              success: true,
              name: 'release-check',
            },
          ],
        },
      }),
    } as Response);

    await expect(
      importSkills('http://example.test', [
        { filename: 'release-check.md', content: '# Release check' },
      ]),
    ).resolves.toEqual(
      expect.objectContaining({ imported: 1 }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/skills/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          files: [
            { filename: 'release-check.md', content: '# Release check' },
          ],
        }),
      }),
    );
  });

  /**
   * station#3378 review (HIGH). `unwrapOrchestrationResponse` only reached its
   * `StationHttpError` throw AFTER `response.json()` succeeded, so a 401/403
   * whose body is not JSON — what a reverse proxy, tunnel or access gateway in
   * front of Station returns — arrived as a bare `Error`. Every consumer that
   * classifies terminality by `instanceof StationHttpError` (the SSE
   * transport's `classifySseFailure`, and `useSessionEventStream`'s history
   * ladder) then read it as transient and retried a request that can never
   * clear. The status is the only fact a retry decision can be made from, so
   * losing it is the defect, not the missing body.
   */
  function nonJsonResponse(status: number): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response;
  }

  it('orchestration: a non-JSON 401 keeps its status instead of degrading to a bare Error', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(401));

    const failure = await getOrchestrationSessionEventWindow(
      'http://example.test',
      'thread-1',
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(StationHttpError);
    expect((failure as StationHttpError).status).toBe(401);
    // Message unchanged — this preserves a fact, it does not restate one.
    expect((failure as Error).message).toBe('Orchestration API error: 401');
  });

  it('orchestration: a non-JSON 403 keeps its status too', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(403));

    const failure = await getOrchestrationSessionEventWindow(
      'http://example.test',
      'thread-1',
    ).catch((cause: unknown) => cause);

    expect((failure as StationHttpError).status).toBe(403);
  });

  it('orchestration: an unparseable 2xx body stays a plain Error — there is no failure status to carry', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(200));

    const failure = await getOrchestrationSessionEventWindow(
      'http://example.test',
      'thread-1',
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StationHttpError);
  });

  it('agents: getAgent surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'agent not found' }, 404),
    );

    await expect(getAgent('http://example.test', 'slug')).rejects.toThrow(
      'agent not found',
    );
  });

  it('conversations: listAgentConversations surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'conversations unavailable' }),
    );

    await expect(
      listAgentConversations('http://example.test', 'agent-slug'),
    ).rejects.toThrow('conversations unavailable');
  });

  it('conversations: listConversationInventory surfaces the server error body on a non-2xx response (S2 of #1302)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({
        success: false,
        error: 'conversation inventory unavailable',
      }),
    );

    await expect(
      listConversationInventory('http://example.test'),
    ).rejects.toThrow('conversation inventory unavailable');
  });

  it('conversations: listConversationInventory sends bounded cursor pagination and returns the page envelope', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { items: [], hasMore: true, nextCursor: 'opaque-next' },
      }),
    } as Response);

    await expect(
      listConversationInventory('http://example.test', {
        cursor: 'opaque-current',
        limit: 25,
      }),
    ).resolves.toEqual({ items: [], hasMore: true, nextCursor: 'opaque-next' });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/conversations?cursor=opaque-current&limit=25',
      expect.anything(),
    );
  });

  it('conversations: listAgentConversationPage exposes stable second-page traversal while the array helper remains first-page only', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            items: [{ id: 'conversation-first' }],
            hasMore: true,
            nextCursor: 'opaque-second-page',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [{ id: 'conversation-second' }], hasMore: false },
        }),
      } as Response);

    await expect(
      listAgentConversationPage('http://example.test', 'agent-slug', {
        limit: 25,
      }),
    ).resolves.toEqual({
      items: [{ id: 'conversation-first' }],
      hasMore: true,
      nextCursor: 'opaque-second-page',
    });
    await expect(
      listAgentConversationPage('http://example.test', 'agent-slug', {
        cursor: 'opaque-second-page',
        limit: 25,
      }),
    ).resolves.toEqual({
      items: [{ id: 'conversation-second' }],
      hasMore: false,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://example.test/agents/agent-slug/conversations?cursor=opaque-second-page&limit=25',
      expect.anything(),
    );
  });

  it('integrations: listIntegrations surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'integrations unavailable' }),
    );

    await expect(listIntegrations('http://example.test')).rejects.toThrow(
      'integrations unavailable',
    );
  });

  it('orchestration: getProviderCommands surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'provider not found' }, 404),
    );

    await expect(
      getProviderCommands('http://example.test', 'acp'),
    ).rejects.toThrow('provider not found');
  });

  it('orchestration: getSessionFlowRun surfaces the server error body on a non-2xx, non-404 response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse(
        { success: false, error: 'flow run lookup failed' },
        500,
      ),
    );

    await expect(
      getSessionFlowRun('http://example.test', 'thread-1'),
    ).rejects.toThrow('flow run lookup failed');
  });

  it('orchestration: getSessionFlowRun resolves to null on a 404 (no Flow run bound) rather than throwing (#168)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse(
        { success: false, error: 'No Flow run bound to session' },
        404,
      ),
    );

    await expect(
      getSessionFlowRun('http://example.test', 'thread-1'),
    ).resolves.toBeNull();
  });

  it('orchestration: respondToRequest surfaces the server error and preserves the failure receipt (#165 iteration-2 LOW fix)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse(
        {
          success: false,
          error: 'decision rejected: request already resolved',
          receipt: { commandId: 'cmd-1', type: 'respondToRequest' },
        },
        400,
      ),
    );

    await expect(
      respondToRequest('http://example.test', {
        threadId: 'thread-1',
        requestId: 'req-1',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({
      message: 'decision rejected: request already resolved',
      receipt: { commandId: 'cmd-1', type: 'respondToRequest' },
    });
  });

  /**
   * station#3437: `respondToRequest` had the identical non-JSON-body status
   * drop `unwrapOrchestrationResponse` was fixed for one function over
   * (station#3378). Same fixture, same shape, message text unchanged.
   */
  it('orchestration: respondToRequest on a non-JSON 401 keeps its status instead of degrading to a bare Error', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(401));

    const failure = await respondToRequest('http://example.test', {
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'accept',
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(StationHttpError);
    expect((failure as StationHttpError).status).toBe(401);
    // Message unchanged — this preserves a fact, it does not restate one.
    expect((failure as Error).message).toBe('Orchestration API error: 401');
  });

  it('orchestration: respondToRequest on a non-JSON 403 keeps its status too', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(403));

    const failure = await respondToRequest('http://example.test', {
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'accept',
    }).catch((cause: unknown) => cause);

    expect((failure as StationHttpError).status).toBe(403);
  });

  it('orchestration: respondToRequest on an unparseable 2xx body stays a plain Error — there is no failure status to carry', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(200));

    const failure = await respondToRequest('http://example.test', {
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'accept',
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StationHttpError);
  });

  /**
   * station#3437 review (MEDIUM): the fix above only extended the
   * non-JSON-body path. Station's own runtime answers an unauthenticated API
   * request with a JSON envelope that PARSES fine
   * (`c.json({success:false,error}, 401)`, `runtime-http.ts`), so this is the
   * common case the commit's "a future caller can now classify by `instanceof
   * StationHttpError`" claim needs to hold for. Before this fix `payload`
   * parsed successfully and control fell through to a bare `new Error(...)`,
   * losing the status for exactly the response Station itself sends.
   */
  it("orchestration: respondToRequest on a JSON 401 body (Station's own unauthenticated shape) is classified StationHttpError, not a bare Error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'Unauthorized' }, 401),
    );

    const failure = await respondToRequest('http://example.test', {
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'accept',
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(StationHttpError);
    expect((failure as StationHttpError).status).toBe(401);
    expect((failure as Error).message).toBe('Unauthorized');
  });

  /**
   * station#3437 review round 2 (LOW-4). `!response.ok || !payload.success`
   * has a case none of the fixtures above cover: an `ok` (2xx) response
   * whose parsed body still says `success: false`. That takes the
   * `response.ok ? new Error(message) : ...` ternary's TRUE arm — a bare
   * `Error`, not a `StationHttpError`, even though the server explicitly
   * reported a failure. Station's own `/commands` route
   * (`src-server/routes/orchestration/orchestration.ts`) never actually
   * answers this way (200 always pairs with `success:true`; a command
   * failure is a 400/409), so this arm is unreachable against Station's own
   * runtime — but the corpus should still name the case rather than leave a
   * silent gap in `!response.ok || !payload.success`'s coverage.
   */
  it('orchestration: respondToRequest on an ok (200) response with success:false is still classified a plain Error, not a StationHttpError', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: 'nope' }),
    } as Response);

    const failure = await respondToRequest('http://example.test', {
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'accept',
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StationHttpError);
    expect((failure as Error).message).toBe('nope');
  });

  it('projects: listProjects surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'projects unavailable' }),
    );

    await expect(listProjects('http://example.test')).rejects.toThrow(
      'projects unavailable',
    );
  });

  /**
   * 4-HOME-006. Station's auth refusal is `{"error":{"code":…}}` — an OBJECT,
   * with no `success` key — and the projects client used to coerce it with
   * `new Error(json.error)`, rendering the literal string `[object Object]`
   * in the New Project modal. The assertion below is written against the
   * defect: `not.toThrow('[object Object]')` alone would pass for any
   * message at all, so it pins the code the server actually computed.
   */
  it('projects: an object-shaped 401 auth envelope reports its code, never [object Object]', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ error: { code: 'authentication_required' } }, 401),
    );

    const failure = await createProject('http://example.test', {
      name: 'Audit Alpha',
      slug: 'audit-alpha',
    }).catch((cause: unknown) => cause);

    expect((failure as Error).message).toBe('authentication_required');
    expect((failure as Error).message).not.toContain('[object Object]');
    expect(failure).toBeInstanceOf(StationHttpError);
    expect((failure as StationHttpError).status).toBe(401);
  });

  it('projects: an object-shaped envelope prefers its message over its code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse(
        { error: { code: 'project_slug_taken', message: 'Name is taken' } },
        409,
      ),
    );

    await expect(
      createProject('http://example.test', { name: 'A', slug: 'a' }),
    ).rejects.toThrow('Name is taken');
  });

  it('projects: a non-JSON 502 keeps its status and says so instead of throwing a parse error', async () => {
    vi.mocked(fetch).mockResolvedValue(nonJsonResponse(502));

    const failure = await listProjects('http://example.test').catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(StationHttpError);
    expect((failure as StationHttpError).status).toBe(502);
    expect((failure as Error).message).toBe('Request failed with HTTP 502');
  });

  /**
   * The other half of "branch on `response.ok` FIRST": a 200 that carries
   * `success:false` is still a refusal, and must not be reported as a
   * transport failure with a status.
   */
  it('projects: an ok body with success:false stays a plain Error carrying the route message', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: 'Project not found' }),
    } as Response);

    const failure = await listProjects('http://example.test').catch(
      (cause: unknown) => cause,
    );

    expect(failure).not.toBeInstanceOf(StationHttpError);
    expect((failure as Error).message).toBe('Project not found');
  });

  it('skills: fetchSystemSkills surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      nonOkJsonResponse({ success: false, error: 'skills unavailable' }),
    );

    await expect(fetchSystemSkills('http://example.test')).rejects.toThrow(
      'skills unavailable',
    );
  });
});
