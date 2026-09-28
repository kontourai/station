import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { attachmentBlobRefFor } from '../attachment-blob-store.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

type TurnStarted = Extract<CanonicalRuntimeEvent, { method: 'turn.started' }>;

const pixels = Buffer.alloc(6 * 1024, 7);
const dataUrl = `data:image/png;base64,${pixels.toString('base64')}`;

/**
 * archive#4134: every provider event is projected once (inline attachment
 * bytes become a server-only blob reference) and that projected event is what
 * the live event bus carries; a completed turn persists with the outputs its
 * native calls declared.
 */
test('a provider event reaches the live bus projected, and its turn persists its declared outputs', async () => {
  const root = makeTempDir('provider-event-projection-');
  const workspaceRoot = makeTempDir('provider-event-workspace-');
  writeFileSync(join(workspaceRoot, 'result.txt'), 'declared bytes');
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const bus = new EventBus();
  const published: CanonicalRuntimeEvent[] = [];
  bus.subscribe(({ event, data }) => {
    if (event === 'orchestration:event')
      published.push(data?.event as CanonicalRuntimeEvent);
  });
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get() {
        return undefined;
      },
      list() {
        return [];
      },
    } as any,
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() } as any,
  });
  const privateService = service as any;
  const threadId = 'projected-thread';
  const turnId = 'projected-turn';
  try {
    const authority = privateService.nativeOutputGrants;
    const grant = authority.issue(
      {
        threadId,
        turnId,
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: { revision: 1 },
        workspaceRoot,
      },
      { isCurrent: () => true },
    );
    const scope = authority.bindNativeCall(grant, 'projected-call');
    await privateService.nativeOutputDeclarations.declare(scope, {
      label: 'Report',
      file: { path: 'result.txt', mediaType: 'text/plain' },
    });

    const started: TurnStarted = {
      eventId: 'projected-started',
      provider: 'claude',
      threadId,
      turnId,
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'turn.started',
      prompt: 'what is in this screenshot?',
      metadata: { userId: 'owner-a' },
      attachments: [
        {
          kind: 'image',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: pixels.length,
          dataUrl,
        },
      ],
    };
    privateService.projectAndPublishEvent(started);
    privateService.projectAndPublishEvent({
      eventId: 'projected-completed',
      provider: 'claude',
      threadId,
      turnId,
      createdAt: '2026-09-24T00:00:01.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
    });

    const ref = attachmentBlobRefFor(pixels);
    const [liveStart] = published.filter(
      (event) => event.method === 'turn.started',
    ) as TurnStarted[];
    expect(liveStart?.attachments).toEqual([
      {
        kind: 'image',
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: pixels.length,
        blobRef: ref,
      },
    ]);
    expect(JSON.stringify(published)).not.toContain('base64,');
    expect(store.listAttachmentThreads(ref)).toEqual([threadId]);

    expect(
      store.listDeclaredOutputDescriptors({ threadId, limit: 10 }).rows,
    ).toEqual([
      expect.objectContaining({
        eventId: 'projected-completed',
        turnId,
        toolCallId: 'projected-call',
        label: 'Report',
      }),
    ]);
  } finally {
    await service.shutdown();
    store.close();
  }
});
