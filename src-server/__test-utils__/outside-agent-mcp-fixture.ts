import { randomBytes } from 'node:crypto';
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import { Hono } from 'hono';
import { afterEach, expect, vi } from 'vitest';
import { trackTempDirs } from '../__test-utils__/temp-dirs.js';
import { createOutsideAgentMcpServer } from '../routes/outside-agent/mcp-routes.js';
import { outsideAgentTokenAudience } from '../security/outside-agent-token-audience.js';
import { OutsideAgentManagementService } from '../services/outside-agent/management-service.js';
import { DAY } from '../services/outside-agent/oauth-records.js';
import { pkceChallenge } from '../services/outside-agent/oauth-registration.js';

const temp = trackTempDirs();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
export const issuer = 'http://127.0.0.1:43141';
const resource = `${issuer}/mcp`;
const redirectUri = 'http://127.0.0.1:43198/callback';
export const protocols = ['2025-06-18', '2025-11-25'];
export async function outsideMcpFixture() {
  const home = temp('outside-r4a-');
  const clock = { now: 1_800_000_000_000 };
  const authority = { live: true };
  const projects: ProjectConfig[] = ['alpha', 'foreign'].map((slug) => ({
    id: `id-${slug}`,
    slug,
    name: slug,
    createdAt: '2026-10-25',
    updatedAt: '2026-10-25',
  }));
  const source = {
    listProjects: vi.fn((): ProjectMetadata[] =>
      projects.map((p) => ({
        ...p,
        hasWorkingDirectory: false,
        layoutCount: 0,
        hasKnowledge: false,
      })),
    ),
    getProject: vi.fn((slug: string) => {
      const project = projects.find((p) => p.slug === slug);
      if (!project) throw new Error('Missing');
      return project;
    }),
  };
  const actor = {
    kind: 'host' as const,
    id: 'host',
    authorityRevision: 'epoch',
    delegatingPrincipalId: 'operator',
  };
  const service = OutsideAgentManagementService.open(
    home,
    { stationId: 'r4a', bootId: 'boot', issuer, now: () => clock.now },
    {
      current: () => authority.live,
      projectExists: (id) => projects.some((p) => p.id === id),
      resolveProject: (slug) => projects.find((p) => p.slug === slug) ?? null,
      describeProject: (id) => projects.find((p) => p.id === id) ?? null,
    },
  );
  const store = service.store;
  const server = await createOutsideAgentMcpServer({
    store,
    validateGrant: (g) => service.validateGrant(g),
    projects: source,
    exposure: { issuer, allowLoopbackHttp: true, hosted: false },
    checkServe: async () => 'clear',
  });
  cleanup.push(() => {
    server.close();
    store.close();
  });
  const app = new Hono();
  app.use('*', outsideAgentTokenAudience);
  app.route('', server.app);
  const request = (
    path = '/mcp',
    init: RequestInit = {},
    raw: {
      peer?: string;
      rawPath?: string;
      extra?: string[];
      app?: Pick<Hono<{ Bindings: object }>, 'request'>;
    } = {},
  ) => {
    const headers = new Headers({
      host: new URL(issuer).host,
      accept: 'application/json, text/event-stream',
    });
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    return (raw.app ?? app).request(
      `${issuer}${path}`,
      { ...init, headers },
      {
        incoming: {
          url: raw.rawPath ?? path,
          rawHeaders: [...headers].flat().concat(raw.extra ?? []),
          socket: { remoteAddress: raw.peer ?? '127.0.0.1' },
        },
      },
    );
  };
  const grant = (global = false) => {
    const client = store.register({
      application_type: 'native',
      redirect_uris: [redirectUri],
    });
    const verifier = randomBytes(32).toString('base64url');
    const flow = store.start({
      clientId: client.id,
      redirectUri,
      resource,
      state: 'state',
      challenge: pkceChallenge(verifier),
    });
    const action = {
      operation: 'approve' as const,
      requestId: flow.request.id,
      clientId: client.id,
      expectedRequestFingerprint: service
        .list(actor)
        .pending.find((r) => r.requestId === flow.request.id)!
        .expectedRequestFingerprint,
      accessLevel: 'read-only' as const,
      project: global
        ? { kind: 'global' as const }
        : { kind: 'project' as const, slug: 'alpha' },
      expiresAt: clock.now + DAY,
      supersessions: [],
    };
    const review = service.review(action, actor);
    service.commit(
      {
        action,
        fingerprint: review.fingerprint,
        decisionId: randomBytes(24).toString('hex'),
      },
      actor,
    );
    const completed = store.complete(flow.request.id, flow.ticket, flow.nonce);
    return store.exchange({
      code: completed.code,
      clientId: client.id,
      redirectUri,
      resource,
      verifier,
    });
  };
  let id = 0;
  const rpc = (
    token: string,
    method: string,
    params: unknown = {},
    session?: string,
    version = protocols[1],
    accept = 'application/json, text/event-stream',
  ) =>
    request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept,
        ...(session
          ? { 'mcp-session-id': session, 'mcp-protocol-version': version! }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
  const initialize = async (
    token: string,
    version = protocols[1],
    accept?: string,
  ) => {
    const response = await rpc(
      token,
      'initialize',
      {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'contract-test', version: '1' },
      },
      undefined,
      version,
      accept,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const session = response.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    return { session, response };
  };
  return {
    home,
    clock,
    authority,
    source,
    projects,
    service,
    store,
    server,
    app,
    request,
    grant,
    rpc,
    initialize,
  };
}
export async function outsideMcpPayload(response: Response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l.length > 6);
    return JSON.parse(events.at(-1)!.slice(6));
  }
  return JSON.parse(text);
}
