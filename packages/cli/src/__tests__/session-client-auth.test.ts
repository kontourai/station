import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  orchestrationStreamFailureMessage,
  sendExecutionTargetChat,
} from '../commands/session-client.js';

const plainTarget: ExecutionTarget = {
  environment: { kind: 'current' },
  agent: agentId('reviewer'),
};
const overrideTarget: ExecutionTarget = {
  environment: { kind: 'current' },
  agent: {
    kind: 'agent-execution-override',
    agent: agentId('reviewer'),
    executionAgent: agentId('codex'),
  },
};

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

  test.each([plainTarget, overrideTarget])(
    'a 401 on the event stream names credentials for target $agent',
    async (target) => {
      const error = await sendExecutionTargetChat(apiBase, target, {
        message: 'hi',
        jsonMode: false,
      }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message).toContain('HTTP 401');
      expect(error?.message).toContain('STATION_API_CREDENTIAL');
      expect(error?.message).toContain('--credential');
    },
  );

  test('a non-auth failure keeps the plain status message', async () => {
    status = 500;
    const error = await sendExecutionTargetChat(apiBase, plainTarget, {
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
