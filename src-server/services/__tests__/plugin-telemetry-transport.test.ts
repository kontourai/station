import type { RequestOptions } from 'node:https';
import { expect, test, vi } from 'vitest';
import { sendPluginTelemetry } from '../plugin-telemetry-transport.js';

const wire = vi.hoisted(() => ({
  status: 202,
  calls: [] as Array<{ url: URL; options: RequestOptions; body: string }>,
}));
vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    request(
      url: URL,
      options: RequestOptions,
      receive: (response: { statusCode: number; destroy: () => void }) => void,
    ) {
      return Object.assign(new EventEmitter(), {
        end(body: string) {
          wire.calls.push({ url, options, body });
          receive({ statusCode: wire.status, destroy() {} });
        },
      });
    },
  };
});

test('HTTPS uses only the validated DNS answer while retaining hostname verification, and refuses redirects', async () => {
  const signal = new AbortController().signal;
  const selected = { address: '8.8.8.8', family: 4 as const };
  expect(
    await sendPluginTelemetry(
      'https://publisher.example.test/counts',
      '{}',
      selected,
      signal,
    ),
  ).toBe(true);
  const call = wire.calls[0];
  expect(call.url.hostname).toBe('publisher.example.test');
  expect(call.options.rejectUnauthorized).toBe(true);
  expect(call.options.agent).toBe(false);
  expect(call.options.signal).toBe(signal);
  const result = await new Promise<unknown>((resolve, reject) => {
    call.options.lookup!(
      'publisher.example.test',
      { all: true },
      (error, address) => (error ? reject(error) : resolve(address)),
    );
  });
  expect(result).toEqual([{ address: '8.8.8.8', family: 4 }]);
  wire.status = 302;
  expect(
    await sendPluginTelemetry(
      'https://publisher.example.test/counts',
      '{}',
      selected,
      signal,
    ),
  ).toBe(false);
  expect(wire.calls).toHaveLength(2);
});
