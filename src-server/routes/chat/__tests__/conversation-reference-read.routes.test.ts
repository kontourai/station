/**
 * #3159 fix round: the read route's admission order and reference matching,
 * with the route's own dependencies stubbed and the caller bound the way the
 * station-control authority guard binds it. The production composition and
 * a real engine process are covered by
 * `runtime-routes-station-control-conversation-read.test.ts`.
 */
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import type { StationControlDispatchTarget } from '../../../tools/station-control-policy.js';
import { STATION_CONTROL_OPERATOR_PRINCIPAL_ID } from '../../../tools/station-control-policy.js';
import type { StationControlCaller } from '../../../tools/station-control-shared.js';
import { createConversationReferenceReadRoutes } from '../conversation-reference-read.js';

const OWNER = 'human:test:owner';
const AGENT: StationControlCaller = {
  sessionId: 'caller',
  conversationId: 'caller-conv',
  assurance: 'bearer-exposed',
  principal: { id: OWNER, source: 'session-owner', elevationEligible: true },
  localProjectId: 'project-1',
  projectIdSource: 'session-record',
};
const BOUND_OPERATOR: StationControlCaller = {
  sessionId: 'operator-session',
  assurance: 'bound',
  principal: {
    id: STATION_CONTROL_OPERATOR_PRINCIPAL_ID,
    source: 'session-owner',
    elevationEligible: true,
  },
};

/** Conversation `C1` was started as session `C1` and continued in `S1`. */
const SESSIONS: Record<string, string> = { S1: 'C1', caller: 'caller-conv' };
const THREADS: Record<string, string[]> = {
  C1: ['C1', 'S1'],
  'caller-conv': ['caller-conv', 'caller'],
};
const TARGETS: Record<string, StationControlDispatchTarget> = {
  // The owner's, in another Project.
  C1: {
    ownerId: OWNER,
    scope: { kind: 'project', id: 'project-2' },
    host: false,
    remote: false,
    ownerHoldsAction: true,
  },
  // Another person's.
  'other-owner': {
    ownerId: 'human:test:someone-else',
    scope: { kind: 'project', id: 'project-1' },
    host: false,
    remote: false,
    ownerHoldsAction: true,
  },
};
const message = (id: string): ConversationMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text: `${id} text` }],
});

function app(
  caller: StationControlCaller,
  turns: { thread: string; prompt: string; actor: unknown }[],
) {
  const conversationIdOf = (id: string) => SESSIONS[id] ?? id;
  const routes = createConversationReferenceReadRoutes({
    readConversationMessages: async (_request, _slug, conversationId) =>
      TARGETS[conversationId]
        ? {
            messages: [message(`${conversationId}-m1`)],
            source: 'orchestration',
          }
        : { messages: [], source: 'empty' },
    authorityFor: () => ({ userId: OWNER }) as never,
    conversationAgent: async () => undefined,
    conversationIdOf,
    conversationThreadsOf: (id) => {
      const conversation = conversationIdOf(id);
      return THREADS[conversation] ?? [id];
    },
    turnPromptsContaining: (threads, needle) =>
      turns.filter(
        (turn) => threads.includes(turn.thread) && turn.prompt.includes(needle),
      ),
    isPersonActor: (actor) =>
      (actor as { kind?: string } | undefined)?.kind === 'operator',
    scope: {
      target: (ref) =>
        ref.kind === 'conversation' ? TARGETS[ref.conversationId] : undefined,
      conversationExists: () => true,
    },
    logger: { warn() {} },
  });
  const host = new Hono();
  host.use('*', async (c, next) => {
    bindStationControlRequestAuthority(c.req.raw, {
      kind: 'caller',
      caller,
      boundOperator: caller.assurance === 'bound',
    });
    await next();
  });
  host.route('/api/conversations', routes);
  return async (path: string) => {
    const response = await host.request(path);
    return { status: response.status, body: (await response.json()) as any };
  };
}

const cursorFor = (conversationId: string, offset: number) =>
  Buffer.from(
    JSON.stringify({ v: 1, c: conversationId, o: offset }),
    'utf8',
  ).toString('base64url');

describe('read_conversation admission', () => {
  test('a person’s reference to one of a conversation’s sessions admits the conversation', async () => {
    const read = app(AGENT, [
      {
        thread: 'caller',
        // The person referenced session S1; the agent asks for conversation C1.
        prompt: 'Compare with [Earlier](/activity?session=S1).',
        actor: { kind: 'operator' },
      },
    ]);
    expect(await read('/api/conversations/C1/read')).toMatchObject({
      status: 200,
      body: {
        success: true,
        data: { conversationId: 'C1', access: 'reference' },
      },
    });
    // The same conversation asked for by its session id is the same grant.
    expect(await read('/api/conversations/S1/read')).toMatchObject({
      status: 200,
      body: { data: { conversationId: 'C1', access: 'reference' } },
    });
  });

  test('without that reference the same request is out of scope', async () => {
    const read = app(AGENT, [
      {
        thread: 'caller',
        // A longer id sharing the prefix is not a reference to S1.
        prompt: 'See [Other](/activity?session=S10).',
        actor: { kind: 'operator' },
      },
    ]);
    expect(await read('/api/conversations/C1/read')).toMatchObject({
      status: 403,
      body: { code: 'conversation_out_of_scope' },
    });
  });

  test('a cursor is judged only after admission, so it reveals nothing about another person’s conversation', async () => {
    const read = app(AGENT, []);
    // A cursor naming a different conversation would be refused as invalid
    // if it were checked first, telling the caller the two ids differ.
    for (const forged of [cursorFor('anything', 0), 'not-a-cursor']) {
      expect(
        await read(`/api/conversations/other-owner/read?cursor=${forged}`),
      ).toMatchObject({
        status: 404,
        body: { code: 'conversation_not_found' },
      });
    }
  });

  test('a bound operator naming an id Station has no record of reads it as not found, not as an empty transcript', async () => {
    const read = app(BOUND_OPERATOR, []);
    expect(await read('/api/conversations/made-up/read')).toMatchObject({
      status: 404,
      body: { code: 'conversation_not_found' },
    });
    // A recorded conversation still reads for the bound operator.
    expect(await read('/api/conversations/other-owner/read')).toMatchObject({
      status: 200,
      body: { data: { access: 'scope', messageCount: 1 } },
    });
  });
});
