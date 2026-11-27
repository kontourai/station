import { ATTACHMENT_INPUT_UNSUPPORTED_CODE } from '@kontourai/station-contracts/provider';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { SendTurnRefusedError } from '../../../providers/adapter-shape.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { OrchestrationCommandDispatchError } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const principal = {
  id: 'human:local:operator',
  kind: 'human' as const,
  display: 'Operator',
};
const owner = { principalId: principal.id };

// The wiring runtime-routes.ts gives the route: hydrate binds, release unbinds.
function appWithRefusingEngine(
  refusal = Object.assign(new Error('This engine takes no images.'), {
    code: ATTACHMENT_INPUT_UNSUPPORTED_CODE,
  }) as Error,
) {
  const staging = new AttachmentStagingService();
  const hydrated: string[] = [];
  const executeForegroundMessage = vi.fn(async (request: any) => {
    // The executor resolves the staged references against the turn it
    // resolved, then the engine refuses them before any effect.
    request.resolveAttachments({
      threadId: request.conversationId,
      clientTurnId: request.clientTurnId,
    });
    hydrated.push(request.clientTurnId);
    throw refusal;
  });
  const app = createOrchestrationRoutes({} as any, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    resolvePrincipal: () => principal,
    executeForegroundMessage: executeForegroundMessage as any,
    hydrateStagedAttachments: (p, references, binding) =>
      staging.bindAndHydrate({ principalId: p.id }, references, binding),
    releaseStagedAttachments: (p, references, binding) =>
      staging.releaseBinding({ principalId: p.id }, references, binding),
  });
  return { app, staging, hydrated };
}

const send = (
  app: ReturnType<typeof createOrchestrationRoutes>,
  body: object,
) =>
  app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('a send the engine refuses before accepting the turn', () => {
  const busy = new SendTurnRefusedError(
    'Codex already has an active turn.',
    'busy',
  );
  const dispatchRefusal = new OrchestrationCommandDispatchError(
    busy.message,
    {
      commandId: 'busy-command',
      threadId: 'conversation-1',
      commandType: 'sendTurn',
      status: 'rejected',
      createdAt: '2026-11-26T02:55:22Z',
    },
    undefined,
    'persisted',
    false,
    undefined,
    busy,
  );

  test.each([
    {
      reason: 'unsupported attachment',
      refusal: undefined,
      response: { code: ATTACHMENT_INPUT_UNSUPPORTED_CODE },
    },
    {
      reason: 'busy provider',
      refusal: dispatchRefusal,
      response: { kind: 'busy', failurePhase: 'refused' },
    },
  ])(
    'releases the staged binding after a $reason refusal',
    async ({ refusal, response }) => {
      const { app, staging, hydrated } = appWithRefusingEngine(refusal);
      const prepared = staging.prepare(owner, {
        clientAttachmentId: 'client-attachment-1',
        kind: 'file',
        name: 'note.txt',
        mimeType: 'text/plain',
        size: 5,
      });
      const reference = staging.upload(
        prepared.stageId,
        prepared.uploadGrant,
        'data:text/plain;base64,aGVsbG8=',
      );
      const body = (clientTurnId: string) => ({
        message: 'look at this',
        conversationId: 'conversation-1',
        clientTurnId,
        target: { environment: { kind: 'current' }, agent: 'codex' },
        attachmentRefs: [reference],
      });

      const first = await send(app, body('turn-1'));
      expect(first.status).toBe(400);
      expect(await readJson(first)).toMatchObject(response);

      // Bound to turn-1 and never released, this is refused as "bound to
      // another turn" (stage_forbidden) before the engine is reached again.
      const second = await send(app, body('turn-2'));
      expect(await readJson(second)).toMatchObject(response);
      expect(hydrated).toEqual(['turn-1', 'turn-2']);
    },
  );
});
