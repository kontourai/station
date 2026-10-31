import { expect, test, vi } from 'vitest';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { issueMcpPromptOrigin } from '../../../services/plugins/mcp-prompt-origin-receipt.js';
import { createOrchestrationRoutes } from '../orchestration.js';

test('foreground chat carries the prompt origin into the authorized executor', async () => {
  const execute = vi.fn().mockResolvedValue({
    conversationId: 'conversation',
    sessionId: 'session',
    providerTurnId: 'turn',
    target: { kind: 'agent', id: 'station' },
  });
  const app = createOrchestrationRoutes({} as any, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => 'person',
    isRequestPrincipalCurrent: () => true,
    executeForegroundMessage: execute,
  });
  const response = await app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'MCP prompt',
      target: { environment: { kind: 'current' }, agent: 'station' },
      mcpPromptOrigin: issueMcpPromptOrigin(
        'mail',
        'summarize',
        'MCP prompt',
        true,
      ),
    }),
  });
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      mcpPromptOrigin: { serverId: 'mail', name: 'summarize', untrusted: true },
    }),
  );
  execute.mockClear();
  const forged = await app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'altered',
      target: { environment: { kind: 'current' }, agent: 'station' },
      mcpPromptOrigin: issueMcpPromptOrigin(
        'mail',
        'summarize',
        'MCP prompt',
        false,
      ),
    }),
  });
  expect(forged.status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});
