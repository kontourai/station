import { ATTACHMENT_INPUT_UNSUPPORTED_CODE } from '@kontourai/station-contracts/provider';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const principal = {
  id: 'human:local:operator',
  kind: 'human' as const,
  display: 'Operator',
};
const owner = { principalId: principal.id };

// The wiring runtime-routes.ts gives the route: hydrate binds, release unbinds.
function appWithRefusingEngine() {
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
    throw Object.assign(new Error('This engine takes no images.'), {
      code: ATTACHMENT_INPUT_UNSUPPORTED_CODE,
    });
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

describe('a send the engine refuses for its attachments', () => {
  test('releases the staged binding, so the same stages bind to a new turn', async () => {
    const { app, staging, hydrated } = appWithRefusingEngine();
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
    expect(await readJson(first)).toMatchObject({
      code: ATTACHMENT_INPUT_UNSUPPORTED_CODE,
    });

    // Bound to turn-1 and never released, this is refused as "bound to
    // another turn" (stage_forbidden) before the engine is reached again.
    const second = await send(app, body('turn-2'));
    expect(await readJson(second)).toMatchObject({
      code: ATTACHMENT_INPUT_UNSUPPORTED_CODE,
    });
    expect(hydrated).toEqual(['turn-1', 'turn-2']);
  });
});
