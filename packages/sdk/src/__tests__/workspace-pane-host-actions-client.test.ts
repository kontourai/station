import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  executeWorkspacePaneHostAction,
  getWorkspacePaneHostActions,
  prepareWorkspacePaneHostAction,
} from '../client/workspace-pane-host-actions';

const request = {
  pluginId: 'plugin',
  installationGeneration: `sha256:${'a'.repeat(64)}`,
  actionKey: `plugin-host-action:${'b'.repeat(64)}`,
};
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  setClientCredentialResolver();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});
const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });

test('portable client reads and executes one opaque ticket without paths or caller-owned Agent content', async () => {
  fetcher
    .mockResolvedValueOnce(
      envelope({
        projectSlug: 'one',
        support: 'supported',
        complete: true,
        contributions: [],
      }),
    )
    .mockResolvedValueOnce(
      envelope({ state: 'prepared', ticket: 'a'.repeat(43) }),
    )
    .mockResolvedValueOnce(
      envelope({
        state: 'accepted',
        conversationId: 'conversation',
        sessionId: 'execution',
        turnId: 'turn',
      }),
    );
  expect(
    (await getWorkspacePaneHostActions('http://station.test', 'one'))
      .contributions,
  ).toEqual([]);
  const prepared = await prepareWorkspacePaneHostAction(
    'http://station.test',
    'one',
    request,
  );
  if (prepared.state !== 'prepared') throw new Error('Expected ticket');
  expect(
    await executeWorkspacePaneHostAction(
      'http://station.test',
      'one',
      prepared.ticket,
    ),
  ).toMatchObject({ state: 'accepted', conversationId: 'conversation' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual(request);
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({
    ticket: 'a'.repeat(43),
  });
});

test.each([
  { state: 'accepted', sessionId: 'missing-conversation-and-turn' },
  { state: 'something-new' },
  { state: 'unavailable', reason: '/secret/path' },
])(
  'unrecognized execute response is indeterminate with no retry: %j',
  async (response) => {
    fetcher.mockResolvedValue(envelope(response));
    expect(
      await executeWorkspacePaneHostAction(
        'http://station.test',
        'one',
        'a'.repeat(43),
      ),
    ).toEqual({ state: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('lost execute response does not automatically prepare or replay work', async () => {
  fetcher.mockRejectedValue(new Error('connection lost'));
  expect(
    await executeWorkspacePaneHostAction(
      'http://station.test',
      'one',
      'a'.repeat(43),
    ),
  ).toEqual({ state: 'indeterminate' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('404 is unavailable rather than proof of absent host authority', async () => {
  fetcher.mockResolvedValue(new Response('Not found', { status: 404 }));
  await expect(
    getWorkspacePaneHostActions('http://station.test', 'one'),
  ).rejects.toThrow();
});
