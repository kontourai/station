import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventStore } from '../../services/orchestration/event-store.js';
import { RunService } from '../../services/orchestration/run-service.js';
import { NovaSonicProvider } from '../providers/nova-sonic.js';
import { VoiceSessionService } from '../voice-session.js';

const stores: EventStore[] = [];
const directories: string[] = [];

function rawEvent(event: unknown) {
  return {
    chunk: { bytes: new TextEncoder().encode(JSON.stringify({ event })) },
  };
}

function createMockBody() {
  const events: Array<unknown | null> = [];
  let wake: (() => void) | undefined;
  return {
    push(event: unknown) {
      events.push(event);
      wake?.();
      wake = undefined;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (events.length > 0) {
          const event = events.shift();
          if (event === null) return;
          yield event;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

class MockWebSocket {
  readyState = 1;
  OPEN = 1;
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  send = vi.fn();
  on(event: string, listener: (...args: unknown[]) => void) {
    this.handlers[event] ??= [];
    this.handlers[event].push(listener);
  }
  off(event: string, listener: (...args: unknown[]) => void) {
    this.handlers[event] = (this.handlers[event] ?? []).filter(
      (candidate) => candidate !== listener,
    );
  }
  close() {
    this.readyState = 3;
    for (const listener of this.handlers.close ?? []) listener();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for voice attribution');
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Nova correlated voice attribution', () => {
  test('projects an exact Nova completion through adapter, voice session, EventStore, and RunService', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-run-integration-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'events.sqlite'));
    stores.push(store);
    const body = createMockBody();
    const provider = new NovaSonicProvider({ region: 'us-east-1' });
    (provider as any).client = {
      send: vi.fn().mockResolvedValue({ body }),
    };
    const service = new VoiceSessionService({
      providerFactory: () => provider,
      agentTools: new Map([['station-voice', []]]),
      agentSpecs: new Map([['station-voice', { systemPrompt: '' }]]),
      agentHooks: new Map(),
      voiceTurnRuns: store.voiceTurnRunAuthority(),
    });
    service.createSession(new MockWebSocket() as any);
    await waitFor(() => provider.state === 'listening');

    body.push(
      rawEvent({
        completionStart: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
        },
      }),
    );
    body.push(
      rawEvent({
        completionEnd: {
          sessionId: 'nova-session-a',
          promptName: 'prompt-a',
          completionId: 'completion-a',
          stopReason: 'END_TURN',
        },
      }),
    );
    await waitFor(() => {
      const result = store.voiceTurnRunReader().list();
      return (
        result.kind === 'available' &&
        result.runs.some(
          (run) => run.source === 'voice' && run.status === 'completed',
        )
      );
    });

    const reader = store.voiceTurnRunReader();
    const listed = reader.list();
    expect(listed).toMatchObject({
      kind: 'available',
      runs: [
        expect.objectContaining({
          source: 'voice',
          status: 'completed',
          retryEligible: false,
        }),
      ],
    });
    if (listed.kind !== 'available') throw new Error('expected voice run');
    const runId = listed.runs.find((run) => run.source === 'voice')?.runId;
    expect(runId).toBeTruthy();
    const runService = new RunService(
      { listAgentRuns: async () => [], readAgentRun: async () => null } as any,
      {
        listRunSummaries: async () => [],
        readRunSummary: async () => null,
      } as any,
      store.nativeInvocationRunReader(),
      store.voiceTurnRunReader(),
    );
    await expect(
      runService.readRun(runId!, { mode: 'personal', userId: 'brian' } as any),
    ).resolves.toMatchObject({ runId, source: 'voice', status: 'completed' });
    expect(JSON.stringify(listed)).not.toContain('completion-a');
  });
});
