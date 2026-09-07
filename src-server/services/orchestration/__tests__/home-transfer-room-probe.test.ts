import { afterEach, expect, test, vi } from 'vitest';
import { probeHomeTransferRoom } from '../home-transfer-room-probe.js';

const peer = {
  environmentId: 'remote',
  apiBase: 'https://remote.example.test',
  credential: 'paired-credential-private',
  scope: 'home:transfer',
  label: null,
  createdAt: 1,
  updatedAt: 1,
};
const input = { taskId: 'task-1', channelId: 'channel-1', nonce: 'nonce-1' };
afterEach(() => vi.useRealTimers());
test('pins endpoint and credential to the selected peer and refuses redirects', async () => {
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(url).toBe(
        'https://remote.example.test/api/home-authority/rooms/task-1/identity',
      );
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${peer.credential}`,
      );
      expect(JSON.parse(init?.body as string)).toEqual({
        channelId: input.channelId,
        nonce: input.nonce,
      });
      return new Response('{"observed":true}', { status: 200 });
    },
  );
  expect(await probeHomeTransferRoom(peer, input, fetcher)).toEqual({
    observed: true,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    probeHomeTransferRoom(
      peer,
      input,
      async () =>
        new Response('', {
          status: 302,
          headers: { Location: 'https://other.example.test' },
        }),
    ),
  ).rejects.toThrow('unavailable');
});
test('bounds streamed bodies even without a content-length header', async () => {
  await expect(
    probeHomeTransferRoom(
      peer,
      input,
      async () => new Response('x'.repeat(4097)),
    ),
  ).rejects.toThrow('unavailable');
});
test('the whole-operation deadline covers a stalled body', async () => {
  vi.useFakeTimers();
  const response = new Response(new ReadableStream({ start() {} }));
  const pending = probeHomeTransferRoom(peer, input, async () => response);
  const refused = expect(pending).rejects.toThrow('unavailable');
  await vi.advanceTimersByTimeAsync(15001);
  await refused;
});
test('invalid origins and failures never expose remote credentials or body details', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error(peer.credential);
  });
  await expect(
    probeHomeTransferRoom(
      { ...peer, apiBase: 'https://remote.example.test/path' },
      input,
      fetcher,
    ),
  ).rejects.toThrow('origin');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(probeHomeTransferRoom(peer, input, fetcher)).rejects.toThrow(
    'Remote room identity unavailable',
  );
});
