import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderSendTurnInput } from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const THREAD = 'attachment-terminal-thread';
const DATA = 'data:text/plain;base64,aGVsbG8=';
const makeTempDir = trackTempDirs();
const services: OrchestrationService[] = [];
const stores: EventStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.shutdown();
  for (const store of stores.splice(0)) store.close();
});

class RecordingAdapter extends GateTestAdapter {
  override readonly metadata = {
    ...new GateTestAdapter().metadata,
    capabilities: ['agent-runtime' as const, 'file-input' as const],
  };
  readonly sent: ProviderSendTurnInput[] = [];
  override async sendTurn(input: ProviderSendTurnInput) {
    this.sent.push(input);
    return { threadId: input.threadId, turnId: 'N' };
  }
}

// The terminal retires the turn's boundary by decoding the input retained when
// it was sent. A decode failure there drops the terminal and leaves the thread
// running, so this drives the real send -> terminal -> retirement path.
test.each([
  ['a staged upload', { clientAttachmentId: 'client-attachment-1' }],
  ['one read back for recovery', { blobRef: `sha256-${'a'.repeat(64)}` }],
])(
  'a turn carrying %s still records its terminal and retires its boundary',
  async (_name, leaked) => {
    const store = new EventStore(
      join(makeTempDir('attachment-terminal-'), 'events.sqlite'),
    );
    stores.push(store);
    const adapter = new RecordingAdapter();
    const warn = vi.fn();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn },
    });
    services.push(service);
    service.initialize();
    await service.dispatch({
      type: 'startSession',
      input: { threadId: THREAD, provider: 'claude' },
    });
    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: THREAD,
        clientTurnId: 'attachment-turn',
        input: 'see attached',
        attachments: [
          {
            kind: 'file',
            name: 'note.txt',
            mimeType: 'text/plain',
            size: 5,
            dataUrl: DATA,
            ...leaked,
          } as never,
        ],
      },
    });
    expect(adapter.sent).toHaveLength(1);

    adapter.events.push({
      method: 'turn.completed',
      eventId: 'attachment-turn-terminal',
      provider: 'claude',
      threadId: THREAD,
      turnId: 'N',
      invocationId: adapter.sent[0]?.invocationId,
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() =>
      expect(store.hasEventId('attachment-turn-terminal')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        store.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD),
      ).toEqual({ kind: 'available', active: false }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      'Provider adapter event stream stopped',
      expect.anything(),
    );
  },
  60_000,
);
