/**
 * In-process HTTP fakes of the three vendor APIs, serving the response shapes
 * each vendor's published reference documents. They answer `fetch` calls by
 * method and path, record every request (headers included, so tests can
 * prove which credential reached which vendor), and can be told to answer
 * the next requests with a rate limit.
 *
 * Shapes:
 * - Devin v3: SessionResponse, SessionMessage, `{items, end_cursor,
 *   has_next_page, total}` pages, RFC 9457 ProblemDetail errors.
 *   https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md
 *   https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
 * - GitHub agent tasks: the task object, `sessions[].usage`, `{tasks}` lists.
 *   https://docs.github.com/en/rest/agent-tasks/agent-tasks
 * - Cursor Cloud Agents v1: `{agent, run}`, run objects with `git.branches`,
 *   the agent SSE stream, the usage object, `{error: {code, message}}`.
 *   The JSON bodies below are the reference's own examples.
 *   https://cursor.com/docs/cloud-agent/api/endpoints
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

type Handler = (
  request: RecordedRequest,
  match: RegExpMatchArray,
) => Response | Promise<Response>;

interface Route {
  readonly method: string;
  readonly path: RegExp;
  readonly handle: Handler;
}

export function json(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export class VendorFake {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: Route[] = [];
  readonly #origin: string;
  /** Answer the next N requests with this response instead. */
  #injected: Array<() => Response> = [];

  constructor(origin: string) {
    this.#origin = origin;
  }

  on(method: string, path: RegExp, handle: Handler): this {
    this.#routes.push({ method, path, handle });
    return this;
  }

  /** The next `count` requests are answered by `response()`. */
  inject(count: number, response: () => Response): void {
    for (let i = 0; i < count; i += 1) this.#injected.push(response);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== this.#origin)
      throw new TypeError(`fake ${this.#origin} got a request for ${url.origin}`);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    const method = init?.method ?? 'GET';
    const request: RecordedRequest = { method, url, headers, body };
    this.requests.push(request);
    const injected = this.#injected.shift();
    if (injected) return injected();
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.path);
      if (match) return route.handle(request, match);
    }
    return json(404, { title: 'Not Found', status: 404 });
  };

  /** Requests whose path matches, in order. */
  matching(method: string, path: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method && path.test(request.url.pathname),
    );
  }
}

/** A fetch that routes each origin to its fake. */
export function routedFetch(...fakes: Array<[string, VendorFake]>): typeof fetch {
  return async (input, init) => {
    const origin = new URL(String(input)).origin;
    const fake = fakes.find(([o]) => o === origin)?.[1];
    if (!fake) throw new TypeError(`no fake for ${origin}`);
    return fake.fetch(input, init);
  };
}

// --- Devin ---------------------------------------------------------------------

export interface DevinMessage {
  event_id: string;
  source: 'devin' | 'user';
  message: string;
  created_at: number;
}

export function devinFake(orgId: string) {
  const fake = new VendorFake('https://api.devin.ai');
  const sessions = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, DevinMessage[]>();
  let next = 1;
  const base = `/v3/organizations/${orgId}/sessions`;
  const sessionResponse = (id: string) => sessions.get(id) as Record<string, unknown>;

  fake.on('POST', new RegExp(`^${base}$`), (request) => {
    const id = `devin-${String(next).padStart(12, '0')}`;
    next += 1;
    const body = request.body as { prompt: string };
    // SessionResponse, required fields only on create (status_detail and
    // on_demand_usage are filled in by get and list).
    sessions.set(id, {
      session_id: id,
      url: `https://app.devin.ai/sessions/${id.slice(6)}`,
      status: 'new',
      tags: [],
      org_id: orgId,
      created_at: 1_763_000_000,
      updated_at: 1_763_000_000,
      acus_consumed: 0,
      pull_requests: [],
    });
    messages.set(id, [
      {
        event_id: `${id}-evt-0`,
        source: 'user',
        message: body.prompt,
        created_at: 1_763_000_000,
      },
    ]);
    return json(200, sessionResponse(id));
  });
  fake.on('GET', new RegExp(`^${base}$`), (request) => {
    const first = Number(request.url.searchParams.get('first') ?? 100);
    const items = [...sessions.values()].slice(0, first);
    return json(200, {
      items,
      end_cursor: null,
      has_next_page: false,
      total: sessions.size,
    });
  });
  fake.on('GET', new RegExp(`^${base}/(devin-[^/]+)$`), (_r, match) => {
    const session = sessions.get(match[1] as string);
    return session
      ? json(200, session)
      : json(404, { title: 'Not Found', status: 404, detail: 'No such session' });
  });
  fake.on('POST', new RegExp(`^${base}/(devin-[^/]+)/messages$`), (request, match) => {
    const id = match[1] as string;
    const list = messages.get(id);
    if (!list) return json(404, { title: 'Not Found', status: 404 });
    list.push({
      event_id: `${id}-evt-${list.length}`,
      source: 'user',
      message: (request.body as { message: string }).message,
      created_at: 1_763_000_100,
    });
    return json(200, sessionResponse(id));
  });
  fake.on('GET', new RegExp(`^${base}/(devin-[^/]+)/messages$`), (request, match) => {
    const list = messages.get(match[1] as string);
    if (!list) return json(404, { title: 'Not Found', status: 404 });
    // Opaque cursors over the message index.
    const after = request.url.searchParams.get('after');
    const start = after ? Number(after.replace('c', '')) + 1 : 0;
    const first = Number(request.url.searchParams.get('first') ?? 100);
    const items = list.slice(start, start + first);
    const end = start + items.length - 1;
    return json(200, {
      items,
      end_cursor: items.length > 0 ? `c${end}` : null,
      has_next_page: end + 1 < list.length,
    });
  });
  fake.on('DELETE', new RegExp(`^${base}/(devin-[^/]+)$`), (_r, match) => {
    const session = sessions.get(match[1] as string);
    if (!session) return json(404, { title: 'Not Found', status: 404 });
    session.status = 'exit';
    return json(200, session);
  });

  return {
    fake,
    sessions,
    /** Devin replies (or the session moves on) while Station is not looking. */
    reply(id: string, text: string) {
      const list = messages.get(id) as DevinMessage[];
      list.push({
        event_id: `${id}-evt-${list.length}`,
        source: 'devin',
        message: text,
        created_at: 1_763_000_200,
      });
    },
    setStatus(id: string, status: string, detail?: string) {
      const session = sessions.get(id) as Record<string, unknown>;
      session.status = status;
      session.status_detail = detail;
    },
  };
}

// --- GitHub --------------------------------------------------------------------

export function githubFake() {
  const fake = new VendorFake('https://api.github.com');
  const tasks = new Map<string, Record<string, unknown>>();
  let next = 1;
  fake.on(
    'POST',
    /^\/agents\/repos\/([^/]+)\/([^/]+)\/tasks$/,
    (request) => {
      const id = `task_${next}`;
      next += 1;
      const body = request.body as Record<string, unknown>;
      tasks.set(id, {
        id,
        url: `https://api.github.com/agents/tasks/${id}`,
        html_url: `https://github.com/copilot/tasks/${id}`,
        name: String(body.prompt).slice(0, 40),
        creator: { id: 1 },
        creator_type: 'user',
        owner: { id: 2 },
        repository: { id: 3 },
        state: 'queued',
        session_count: 1,
        artifacts: [],
        archived_at: null,
        created_at: '2026-11-14T10:00:00Z',
        updated_at: '2026-11-14T10:00:00Z',
      });
      return json(201, tasks.get(id));
    },
  );
  fake.on('GET', /^\/agents\/tasks$/, () =>
    json(200, {
      tasks: [...tasks.values()],
      total_active_count: tasks.size,
      total_archived_count: 0,
    }),
  );
  fake.on('GET', /^\/agents\/tasks\/([^/]+)$/, (_r, match) => {
    const task = tasks.get(match[1] as string);
    return task
      ? json(200, task)
      : json(404, {
          message: 'Not Found',
          documentation_url: 'https://docs.github.com/rest',
        });
  });
  return { fake, tasks };
}

// --- Cursor --------------------------------------------------------------------

/** The reference's create-response example. */
export const CURSOR_CREATE_RESPONSE = {
  agent: {
    id: 'bc-00000000-0000-0000-0000-000000000001',
    name: 'Add README with setup instructions',
    status: 'ACTIVE',
    env: { type: 'cloud' },
    repos: [
      { url: 'https://github.com/your-org/your-repo', startingRef: 'main' },
    ],
    workOnCurrentBranch: false,
    autoCreatePR: true,
    url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001',
    createdAt: '2026-04-13T18:30:00.000Z',
    updatedAt: '2026-04-13T18:30:00.000Z',
    latestRunId: 'run-00000000-0000-0000-0000-000000000001',
  },
  run: {
    id: 'run-00000000-0000-0000-0000-000000000001',
    agentId: 'bc-00000000-0000-0000-0000-000000000001',
    status: 'CREATING',
    createdAt: '2026-04-13T18:30:00.000Z',
    updatedAt: '2026-04-13T18:30:00.000Z',
  },
};

/** The reference's get-run example (a finished run with a pull request). */
export const CURSOR_FINISHED_RUN = {
  id: 'run-00000000-0000-0000-0000-000000000001',
  agentId: 'bc-00000000-0000-0000-0000-000000000001',
  status: 'FINISHED',
  createdAt: '2026-04-13T18:30:00.000Z',
  updatedAt: '2026-04-13T18:45:00.000Z',
  durationMs: 12357,
  result: 'Added README.md with installation instructions and usage examples.',
  git: {
    branches: [
      {
        repoUrl: 'github.com/your-org/your-repo',
        branch: 'cursor/add-readme-a1b2',
        prUrl: 'https://github.com/your-org/your-repo/pull/123',
      },
    ],
  },
};

/** The reference's usage example. */
export const CURSOR_USAGE = {
  totalUsage: {
    inputTokens: 12480,
    outputTokens: 3110,
    cacheWriteTokens: 18200,
    cacheReadTokens: 42600,
    totalTokens: 76390,
  },
  runs: [],
};

export interface CursorStreamEvent {
  id?: string;
  event: string;
  data: unknown;
}

function sse(events: CursorStreamEvent[]): Response {
  const text = events
    .map(
      (event) =>
        `${event.id !== undefined ? `id: ${event.id}\n` : ''}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
    )
    .join('');
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-cursor-stream-retention-seconds': '3600',
    },
  });
}

export function cursorFake() {
  const fake = new VendorFake('https://api.cursor.com');
  const agentId = CURSOR_CREATE_RESPONSE.agent.id;
  const state = {
    agent: structuredClone(CURSOR_CREATE_RESPONSE.agent) as Record<string, unknown>,
    run: structuredClone(CURSOR_CREATE_RESPONSE.run) as Record<string, unknown>,
    busy: false,
    /** The agent stream as Cursor retains it; `status` without id leads. */
    stream: [] as CursorStreamEvent[],
    expiredBefore: undefined as string | undefined,
  };
  fake.on('POST', /^\/v1\/agents$/, () => json(200, CURSOR_CREATE_RESPONSE));
  fake.on('GET', /^\/v1\/agents$/, () =>
    json(200, { items: [state.agent] }),
  );
  fake.on('GET', /^\/v1\/agents\/([^/]+)$/, (_r, match) =>
    match[1] === agentId
      ? json(200, state.agent)
      : json(404, { error: { code: 'agent_not_found', message: 'Agent not found' } }),
  );
  fake.on('GET', /^\/v1\/agents\/[^/]+\/runs\/([^/]+)$/, () => json(200, state.run));
  fake.on('POST', /^\/v1\/agents\/[^/]+\/runs$/, (request) => {
    const body = request.body as Record<string, unknown>;
    if (body.delivery === 'steer')
      return json(202, { delivery: 'steered', runId: state.run.id });
    if (state.busy)
      return json(409, {
        error: { code: 'agent_busy', message: 'Agent already has an active run' },
      });
    return json(200, {
      run: {
        id: 'run-00000000-0000-0000-0000-000000000002',
        agentId,
        status: 'CREATING',
        createdAt: '2026-04-13T18:50:00.000Z',
        updatedAt: '2026-04-13T18:50:00.000Z',
      },
    });
  });
  fake.on('POST', /^\/v1\/agents\/[^/]+\/runs\/([^/]+)\/cancel$/, (_r, match) => {
    state.run.status = 'CANCELLED';
    return json(200, { id: match[1] });
  });
  fake.on('GET', /^\/v1\/agents\/[^/]+\/usage$/, () => json(200, CURSOR_USAGE));
  fake.on('GET', /^\/v1\/agents\/[^/]+\/stream$/, (request) => {
    const last = request.headers.get('last-event-id');
    if (last && state.expiredBefore && last < state.expiredBefore)
      return json(410, {
        error: { code: 'stream_expired', message: 'Stream retention expired' },
      });
    const status: CursorStreamEvent = {
      event: 'status',
      data: { agentId, status: state.run.status },
    };
    const index = last
      ? state.stream.findIndex((event) => event.id === last) + 1
      : 0;
    return sse([
      status,
      ...state.stream.slice(index),
      { event: 'heartbeat', data: {} },
    ]);
  });
  return { fake, state, agentId };
}
