/**
 * #2377 slice C3b: the conversation handoff route refuses an approval posture
 * from a station-control caller that is not a bound operator.
 *
 * No station-control tool reaches this route today (the guard refuses it as
 * unmapped), so the runtime matrix cannot drive it. This drives the real
 * route with the request authority the guard would bind, so mapping the
 * route later cannot skip the posture check.
 */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createOrchestrationRoutes } from '../orchestration.js';

type Authority = 'agent' | 'bound-operator' | 'none';

function harness() {
  const handedOff: unknown[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    const authority = c.req.header('x-test-authority') as Authority;
    if (authority !== 'none')
      bindStationControlRequestAuthority(c.req.raw, {
        kind: 'caller',
        caller: {
          sessionId: 'op-caller',
          assurance: authority === 'agent' ? 'bearer-exposed' : 'bound',
          principal: {
            id: LOCAL_OPERATOR_PRINCIPAL_ID,
            elevationEligible: true,
          },
        } as never,
        boundOperator: authority === 'bound-operator',
      });
    await next();
  });
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(
      {} as never,
      {
        eventBus: new EventBus(),
        logger: {
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
        },
        getUserId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
        handoffConversation: async (input: unknown) => {
          handedOff.push(input);
          return {
            conversationId: 'c',
            sessionId: 's',
            providerTurnId: 't',
            target: { kind: 'agent', id: 'writer' },
          };
        },
      } as never,
    ),
  );
  const outcome = async (
    authority: Authority,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const before = handedOff.length;
    const response = await app.request(
      '/api/orchestration/conversations/conv-1/handoff',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-authority': authority,
        },
        body: JSON.stringify({
          message: 'go',
          idempotencyKey: 'k',
          target: { agent: 'writer' },
          ...body,
        }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
    };
    if (response.status === 403 && payload.code) return payload.code;
    return handedOff.length > before
      ? 'reached'
      : `not reached (${response.status})`;
  };
  return { outcome };
}

const POSTURE = 'station_control_posture_not_allowed';

describe('POST /conversations/:conversationId/handoff: no approval posture from an agent', () => {
  const carried: Array<[string, Record<string, unknown>]> = [
    [
      'setApprovalMode',
      { setApprovalMode: 'ask', setApprovalModeBasedOn: null },
    ],
    [
      'target.model.options.approvalMode',
      {
        target: {
          agent: 'writer',
          model: { options: { approvalMode: 'auto' } },
        },
      },
    ],
    [
      'target.model.options with another key',
      {
        target: {
          agent: 'writer',
          model: { options: { effort: 'high', autoMode: false } },
        },
      },
    ],
  ];

  test.each(carried)('%s', async (_field, body) => {
    const { outcome } = harness();
    expect(await outcome('agent', body)).toBe(POSTURE);
    expect(await outcome('bound-operator', body)).toBe('reached');
    expect(await outcome('none', body)).toBe('reached');
  });

  test('a handoff without a posture is not refused for an agent', async () => {
    const { outcome } = harness();
    expect(await outcome('agent', {})).toBe('reached');
    expect(
      await outcome('agent', {
        target: { agent: 'writer', model: { options: { effort: 'high' } } },
      }),
    ).toBe('reached');
  });
});
