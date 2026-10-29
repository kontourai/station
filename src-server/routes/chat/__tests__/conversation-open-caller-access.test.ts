/**
 * `GET /api/conversations/:id/open` reports, per caller, whether the server's
 * own HTTP boundary would let that caller continue the conversation or start
 * a chat. The chat dock withholds "Start new chat" and its "send a message"
 * invitation from a caller the server says may not, instead of re-deriving
 * the pairing route table in the client.
 *
 * Driven through the real runtime HTTP middleware (`configureRuntimeHttp`),
 * real pairing presets and the real `runtimeRequestPrincipalMayAccessHttpRoute`
 * gate, with only the conversation reader stubbed.
 */

import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createGlobalConversationRoutes } from '../conversations.js';

const OPERATOR_CREDENTIAL = 'operator-credential-full-authority';
const READ_ONLY_CREDENTIAL = 'device-credential-read-only-scope';
const STANDARD_CREDENTIAL = 'device-credential-standard-scope';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function scopeFor(credential: string): string | undefined {
  if (credential === OPERATOR_CREDENTIAL) return DEFAULT_GRANT_PAIRING_SCOPE;
  if (credential === READ_ONLY_CREDENTIAL)
    return pairingScopePresetString('read-only');
  if (credential === STANDARD_CREDENTIAL)
    return pairingScopePresetString('standard');
  return undefined;
}

/** The principal gate `runtimeRequestPrincipalMayAccessHttpRoute` consults. */
const PRINCIPAL_SECURITY = {
  authorizeCredential: (candidate: string) => scopeFor(candidate) !== undefined,
  resolveGrantedScope: (candidate: string) => scopeFor(candidate),
  verifyOperatorCredential: (candidate: string) =>
    candidate === OPERATOR_CREDENTIAL,
};

const RESOLUTION: ConversationOpenResolution = {
  status: 'unavailable',
  conversation: {
    id: 'conv-1',
    source: 'runtime',
    agentSlug: agentId('codex'),
    title: 'New chat',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    messageCount: 0,
    mutable: false,
    answerability: { answerable: true },
  } as ConversationOpenResolution['conversation'],
  transcript: { available: false, owner: 'runtime' },
  canContinue: false,
  answerability: { answerable: true },
  recoveryActions: ['retry', 'start-new'],
};

/** A saved, authorized fork: the arm whose title the route re-reads. */
const FORK_READY: ConversationOpenResolution = {
  status: 'fork-ready',
  conversation: RESOLUTION.conversation,
  transcript: { available: true, owner: 'fork-context', messageCount: 2 },
  canContinue: true,
  answerability: { answerable: true },
  recoveryActions: [],
};

function createApp(
  principalSecurity?: typeof PRINCIPAL_SECURITY,
  resolution: ConversationOpenResolution = RESOLUTION,
) {
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
      fatal() {},
      child() {
        return this;
      },
      setLevel() {},
      getLevel() {
        return 'info' as const;
      },
    },
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate) => scopeFor(candidate) !== undefined,
      resolveGrantedScope: (candidate) => scopeFor(candidate),
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      new Map(),
      { getConversation: () => null },
      {
        info() {},
        warn() {},
        error() {},
        debug() {},
      } as never,
      undefined,
      {
        resolveConversationOpen: vi.fn(async () => resolution),
        readForkConversation: () => ({
          id: 'conv-1',
          resourceId: 'codex',
          userId: 'operator',
          title: 'Saved fork',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:02:00.000Z',
          metadata: {},
        }),
      } as never,
      () => 'operator',
      undefined,
      () => ({}) as never,
      undefined,
      undefined,
      principalSecurity,
    ),
  );
  // Stand-ins for the two routes callerAccess speaks about, so a request
  // ingress admits is seen to reach them (200) and a refused one is not.
  app.post('/api/orchestration/chat', (c) => c.json({ reached: true }));
  app.post('/api/orchestration/chat/:id/continue', (c) =>
    c.json({ reached: true }),
  );
  return app;
}

/** A request from Station's own attested loopback proxy hop: no bearer. */
const INTERNAL_LOOPBACK = {
  headers: {
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
  },
  env: {
    incoming: { socket: { remoteAddress: '127.0.0.1' } },
  } as TestBindings,
};

const BOUNDARY_PATHS = [
  '/api/orchestration/chat',
  '/api/orchestration/chat/conv-1/continue',
] as const;

async function readCallerAccess(
  app: ReturnType<typeof createApp>,
  credential: string,
) {
  const response = await app.request(
    '/api/conversations/conv-1/open',
    { headers: { Authorization: `Bearer ${credential}` } },
    { incoming: { socket: { remoteAddress: '100.96.12.7' } } } as TestBindings,
  );
  expect(response.status, credential).toBe(200);
  const body = (await response.json()) as {
    data: ConversationOpenResolution;
  };
  return body.data.callerAccess;
}

describe('GET /api/conversations/:id/open callerAccess', () => {
  it('tells each caller whether it may continue the conversation or start a chat', async () => {
    const app = createApp(PRINCIPAL_SECURITY);
    // A read-only paired phone reads the conversation but may post neither.
    await expect(readCallerAccess(app, READ_ONLY_CREDENTIAL)).resolves.toEqual({
      continue: false,
      startChat: false,
    });
    await expect(readCallerAccess(app, STANDARD_CREDENTIAL)).resolves.toEqual({
      continue: true,
      startChat: true,
    });
    await expect(readCallerAccess(app, OPERATOR_CREDENTIAL)).resolves.toEqual({
      continue: true,
      startChat: true,
    });
  });

  it('reports caller access on a saved fork too', async () => {
    const app = createApp(PRINCIPAL_SECURITY, FORK_READY);
    await expect(readCallerAccess(app, READ_ONLY_CREDENTIAL)).resolves.toEqual({
      continue: false,
      startChat: false,
    });
    await expect(readCallerAccess(app, STANDARD_CREDENTIAL)).resolves.toEqual({
      continue: true,
      startChat: true,
    });
  });

  it.each([
    [READ_ONLY_CREDENTIAL, 403],
    [STANDARD_CREDENTIAL, 200],
  ] as const)(
    'agrees with the boundary: %s posts get %i, matching what it was told',
    async (credential, status) => {
      const app = createApp(PRINCIPAL_SECURITY);
      for (const path of BOUNDARY_PATHS) {
        const response = await app.request(
          path,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${credential}` },
          },
          {
            incoming: { socket: { remoteAddress: '100.96.12.7' } },
          } as TestBindings,
        );
        expect(response.status, path).toBe(status);
      }
    },
  );

  it("Station's own loopback proxy (the internal principal) is told it may post, and is admitted", async () => {
    const app = createApp(PRINCIPAL_SECURITY);
    const read = await app.request(
      '/api/conversations/conv-1/open',
      { headers: INTERNAL_LOOPBACK.headers },
      INTERNAL_LOOPBACK.env,
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: ConversationOpenResolution };
    expect(body.data.callerAccess).toEqual({ continue: true, startChat: true });
    for (const path of BOUNDARY_PATHS) {
      const response = await app.request(
        path,
        { method: 'POST', headers: INTERNAL_LOOPBACK.headers },
        INTERNAL_LOOPBACK.env,
      );
      expect(response.status, path).toBe(200);
    }
  });

  it('omits callerAccess when the gate is not wired, so clients read it as unknown', async () => {
    const app = createApp();
    await expect(
      readCallerAccess(app, READ_ONLY_CREDENTIAL),
    ).resolves.toBeUndefined();
  });
});
