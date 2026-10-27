import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerProviderDeps } from '@voltagent/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DIRECT_LISTENER_LINK } from '../../bootstrap/supervisor-link.js';
import { stationHonoServer } from '../voltagent-hono-runtime.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

describe('API listener connection reuse', () => {
  it('keeps an idle connection across a poll interval instead of Node’s 5 s', async () => {
    let port = 0;
    const provider = stationHonoServer(
      {
        port: 0,
        hostname: '127.0.0.1',
        configureFullApp: ({ app }) => {
          app.get('/probe', (c) => c.text('ok'));
        },
      },
      () => ({
        ...DIRECT_LISTENER_LINK,
        async listen(name, server, address) {
          const bound = await DIRECT_LISTENER_LINK.listen(
            name,
            server,
            address,
          );
          port = (server.address() as AddressInfo).port;
          return bound;
        },
      }),
    )({} as ServerProviderDeps);
    stops.push(() => provider.stop());
    await provider.start();

    const keepAlive = await new Promise<string | string[] | undefined>(
      (resolve, reject) => {
        const probe = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/probe',
            headers: { Connection: 'keep-alive' },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.headers['keep-alive']));
          },
        );
        probe.on('error', reject);
        probe.end();
      },
    );
    expect(keepAlive).toBe('timeout=65');
  });
});
