import { expect, test, vi } from 'vitest';
import { guardProjectResponse } from '../project-response-guard.js';

test('refuses a completed response when membership ended before release', async () => {
  const response = await guardProjectResponse(
    Response.json({ private: 'marker' }),
    async () => false,
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('marker');
});

test('rechecks before each queued chunk and cancels without waiting', async () => {
  let current = true;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      controller.enqueue(new TextEncoder().encode('private-second'));
    },
    cancel,
  });
  const response = await guardProjectResponse(
    new Response(source),
    async () => current,
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  current = false;
  await expect(reader.read()).rejects.toThrow(
    'Project authorization ended before response delivery',
  );
  expect(cancel).toHaveBeenCalledOnce();
});
