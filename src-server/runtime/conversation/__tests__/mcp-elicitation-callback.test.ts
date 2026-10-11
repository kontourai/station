import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { InjectableStream } from '../../streaming/InjectableStream.js';
import {
  createElicitationCallback,
  MCP_ELICITATION_TIMEOUT_MS,
} from '../stream-orchestrator.js';

const PARAMS = {
  mode: 'form',
  message: 'Your name?',
  requestedSchema: {
    type: 'object',
    properties: { name: { type: 'string', maxLength: 5 } },
    required: ['name'],
  },
};

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function setup(registry = new ApprovalRegistry(logger)) {
  const stream = new InjectableStream();
  const callback = createElicitationCallback(
    { name: 'Agent' } as any,
    new Map(),
    registry,
    stream,
    logger,
    () => 'conversation-1',
  );
  const injected: any[] = [];
  const original = stream.inject.bind(stream);
  stream.inject = (event) => {
    injected.push(event);
    original(event);
  };
  return { callback, registry, injected };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('#3284 MCP elicitation callback', () => {
  test('a form nobody answers in time resolves as cancel', async () => {
    vi.useFakeTimers();
    const { callback, injected } = setup();
    const answer = callback({
      type: 'mcp-elicitation',
      serverId: 'fixture',
      params: PARAMS,
    });
    expect(injected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MCP_ELICITATION_TIMEOUT_MS + 1);
    await expect(answer).resolves.toEqual({ action: 'cancel' });
  });

  test('an approval with no form answer is cancel, never an accept', async () => {
    const { callback, injected, registry } = setup();
    const answer = callback({
      type: 'mcp-elicitation',
      serverId: 'fixture',
      params: PARAMS,
    });
    registry.resolve(injected[0].approvalId, true);
    await expect(answer).resolves.toEqual({ action: 'cancel' });
  });

  test('content that does not fit the form is refused at the last seam too', async () => {
    const { callback, injected, registry } = setup();
    const answer = callback({
      type: 'mcp-elicitation',
      serverId: 'fixture',
      params: PARAMS,
    });
    registry.resolve(injected[0].approvalId, true, undefined, {
      action: 'accept',
      content: { name: 'Adelaide' },
    });
    await expect(answer).rejects.toThrow('name allows at most 5 characters.');
  });

  test('a form Station cannot render is an error, not a guess', async () => {
    const { callback, injected } = setup();
    await expect(
      callback({
        type: 'mcp-elicitation',
        serverId: 'fixture',
        params: {
          ...PARAMS,
          requestedSchema: {
            type: 'object',
            properties: { address: { type: 'object' } },
          },
        },
      }),
    ).rejects.toThrow('Station cannot show this form');
    expect(injected).toEqual([]);
  });

  test('a hosted turn with no bound session cannot be asked', async () => {
    const registry = new ApprovalRegistry(logger, {
      isHosted: () => true,
      resolveSessionTenant: () => undefined,
      canReadSession: () => false,
    });
    const { callback } = setup(registry);
    await expect(
      callback({
        type: 'mcp-elicitation',
        serverId: 'fixture',
        params: PARAMS,
      }),
    ).rejects.toThrow('not bound to a session');
  });
});
