/**
 * #4511: the scope rule admits the own-Task grant only for the caller's own
 * Session, and only on a route every tool of which is marked `ownTask`.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import type { StationControlCaller } from '../../../tools/station-control-shared.js';
import { scopeDispatch } from '../dispatch-scope.js';

const OWN = 'session-own';
const OTHER_TASK_ROUTE = '/api/orchestration/station-control/task-summary';

async function decide(
  path: string,
  method: string,
  threadId: string,
  caller: Partial<StationControlCaller>,
): Promise<'allowed' | 'refused'> {
  const app = new Hono();
  app.all('*', (c) => {
    const result = scopeDispatch(c, undefined, () => ({
      kind: 'thread',
      threadId,
      remote: false,
    }));
    return c.json({ refused: 'refused' in result });
  });
  const request = new Request(`http://localhost${path}`, { method });
  bindStationControlRequestAuthority(request, {
    kind: 'caller',
    boundOperator: false,
    caller: { sessionId: OWN, ...caller } as StationControlCaller,
  });
  const body = (await (await app.fetch(request)).json()) as {
    refused: boolean;
  };
  return body.refused ? 'refused' : 'allowed';
}

describe('scopeDispatch own-Task grant', () => {
  test("admits the caller's own Session and refuses another Session's id", async () => {
    const grant = { ownTaskId: 'task-1' };
    expect(await decide(OTHER_TASK_ROUTE, 'POST', OWN, grant)).toBe('allowed');
    expect(await decide(OTHER_TASK_ROUTE, 'POST', 'session-other', grant)).toBe(
      'refused',
    );
  });

  test('without the grant, or off an ownTask route, the same request is refused', async () => {
    expect(await decide(OTHER_TASK_ROUTE, 'POST', OWN, {})).toBe('refused');
    expect(
      await decide(
        '/api/orchestration/station-control/task-thread-resolve',
        'POST',
        OWN,
        {
          ownTaskId: 'task-1',
        },
      ),
    ).toBe('refused');
  });
});
