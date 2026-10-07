import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  orchestrationStreamFailureMessage,
  sendExecutionTargetChat,
} from '../commands/session-client.js';

describe('#3304: a rejected CLI credential says how to authenticate', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let status = 401;

  beforeEach(async () => {
    status = 401;
    server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('a 401 on the event stream names STATION_API_CREDENTIAL and --credential', async () => {
    const error = await sendExecutionTargetChat(apiBase, {} as never, {
      message: 'hi',
      jsonMode: false,
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain('HTTP 401');
    expect(error?.message).toContain('STATION_API_CREDENTIAL');
    expect(error?.message).toContain('--credential');
  });

  test('a non-auth failure keeps the plain status message', async () => {
    status = 500;
    const error = await sendExecutionTargetChat(apiBase, {} as never, {
      message: 'hi',
      jsonMode: false,
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe(
      'Orchestration event stream failed with HTTP 500',
    );
    expect(orchestrationStreamFailureMessage(500)).not.toContain(
      'STATION_API_CREDENTIAL',
    );
  });
});
