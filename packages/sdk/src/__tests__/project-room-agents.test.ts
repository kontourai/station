import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { projectRoomAgentRequest } from '../client/project-room-agents';
import { ProjectRoomProtocolError } from '../client/project-rooms';

const scope = {
  apiBase: 'https://room.example',
  authorityKey: 'room-authority',
};
const roomId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const guard = {
  expectedRoomId: roomId,
  expectedProjectId: 'project',
  expectedActorId: 'ada',
};
const intent = {
  ...guard,
  intentId,
  agentId: 'researcher',
  text: 'Investigate together',
};
const handle = {
  roomId,
  requestId: intentId,
  intentId,
  agentId: 'researcher',
  text: intent.text,
  actor: { id: 'ada', displayName: 'Ada', kind: 'person' },
  state: 'started',
  createdAt: '2026-10-22T12:00:00.000Z',
  updatedAt: '2026-10-22T12:00:00.000Z',
};
beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: { ...scope, isCurrent: () => true },
  })),
);
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test.each([
  { sessionId: 'private-session' },
  { executionCorrelationId: 'private-correlation' },
  { roomId: '33333333-3333-4333-8333-333333333333' },
  { requestId: '33333333-3333-4333-8333-333333333333' },
  { state: 'complete' },
])(
  'inspect refuses incompatible or private handle fields %j',
  async (change) => {
    const fetch = vi.fn(async (_input: string) =>
      Response.json({ success: true, data: { ...handle, ...change } }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      projectRoomAgentRequest(scope, 'team', guard, {
        requestId: intentId,
        action: 'inspect',
      }),
    ).rejects.toBeInstanceOf(ProjectRoomProtocolError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${scope.apiBase}/api/projects/team/room/agents/${intentId}`,
    );
  },
);
test('a changed authority guard refuses before an Agent effect', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    projectRoomAgentRequest(scope, 'team', guard, {
      ...intent,
      expectedActorId: 'other-person',
    }),
  ).rejects.toBeInstanceOf(ProjectRoomProtocolError);
  expect(fetch).not.toHaveBeenCalled();
});
