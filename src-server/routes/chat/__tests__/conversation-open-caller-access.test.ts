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
  return app;
}

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

  it('agrees with the boundary: the read-only caller is refused the post it was told it may not make', async () => {
    const app = createApp(PRINCIPAL_SECURITY);
    for (const path of [
      '/api/orchestration/chat',
      '/api/orchestration/chat/conv-1/continue',
    ]) {
      const response = await app.request(
        path,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${READ_ONLY_CREDENTIAL}` },
        },
        {
          incoming: { socket: { remoteAddress: '100.96.12.7' } },
        } as TestBindings,
      );
      expect(response.status, path).toBe(403);
    }
  });

  it('omits callerAccess when the gate is not wired, so clients read it as unknown', async () => {
    const app = createApp();
    await expect(
      readCallerAccess(app, READ_ONLY_CREDENTIAL),
    ).resolves.toBeUndefined();
  });
});
