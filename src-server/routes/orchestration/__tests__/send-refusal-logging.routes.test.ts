import { ATTACHMENT_INPUT_UNSUPPORTED_CODE } from '@kontourai/station-contracts/provider';
import { describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const principal = {
  id: 'human:local:operator',
  kind: 'human' as const,
  display: 'Operator',
};

function appRefusingWith(error: Error) {
  const warn = vi.fn();
  const app = createOrchestrationRoutes({} as any, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn(), warn },
    resolvePrincipal: () => principal,
    executeForegroundMessage: (async () => {
      throw error;
    }) as any,
  });
  const send = () =>
    app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Continue',
        conversationId: 'conversation-1',
        clientTurnId: 'turn-1',
        target: { environment: { kind: 'current' }, agent: 'claude' },
      }),
    });
  return { send, warn };
}

describe('a foreground send the server refuses', () => {
  test('without a failure code is logged with its message, so the generic client copy can be traced', async () => {
    const { send, warn } = appRefusingWith(
      new Error('Something the client cannot translate'),
    );

    const response = await send();

    expect(response.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(
      'Foreground chat message refused without a failure code',
      expect.objectContaining({
        conversationId: 'conversation-1',
        errorName: 'Error',
        error: 'Something the client cannot translate',
        elapsedMs: expect.any(Number),
      }),
    );
  });

  test('with a closed failure code is not logged: its code already names it to the client', async () => {
    const { send, warn } = appRefusingWith(
      Object.assign(new Error('This engine takes no images.'), {
        code: ATTACHMENT_INPUT_UNSUPPORTED_CODE,
      }),
    );

    const response = await send();

    expect(response.status).toBe(400);
    expect(warn).not.toHaveBeenCalledWith(
      'Foreground chat message refused without a failure code',
      expect.anything(),
    );
  });
});
