import { createHash } from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * Deterministic, provider-neutral transport input for station#4294.  The
 * payload is deliberately varied: a compressor-friendly repeated fixture
 * would make a transport regression look cheaper than users' real tool work.
 */
export const ORCHESTRATION_TRANSFER_FIXTURE_VERSION = 1;
export const ORCHESTRATION_TRANSFER_THREAD_ID = 'transfer-budget-thread';
export const ORCHESTRATION_TRANSFER_OWNER = 'transfer-budget-owner';
const TOOL_OUTPUT_BYTES = 48 * 1024;

function seededText(seed: string, bytes: number): string {
  let value = '';
  let counter = 0;
  while (Buffer.byteLength(value, 'utf8') < bytes) {
    value += createHash('sha256')
      .update(`${seed}:${counter++}`)
      .digest('base64url');
  }
  return value.slice(0, bytes);
}

function event(
  index: number,
  method: CanonicalRuntimeEvent['method'],
  values: Record<string, unknown> = {},
): CanonicalRuntimeEvent {
  const turn = Math.floor(index / 16);
  return {
    eventId: `transfer-${String(index).padStart(4, '0')}`,
    provider: 'claude',
    threadId: ORCHESTRATION_TRANSFER_THREAD_ID,
    turnId: `transfer-turn-${String(turn).padStart(2, '0')}`,
    createdAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index)).toISOString(),
    method,
    ...values,
  } as CanonicalRuntimeEvent;
}

export function retainedTransferEvents(): CanonicalRuntimeEvent[] {
  const events: CanonicalRuntimeEvent[] = [
    event(0, 'session.configured', {
      sessionId: ORCHESTRATION_TRANSFER_THREAD_ID,
      metadata: { userId: ORCHESTRATION_TRANSFER_OWNER },
    }),
  ];
  for (let turn = 0; turn < 10; turn += 1) {
    const base = 1 + turn * 16;
    events.push(
      event(base, 'turn.started', { prompt: `retained turn ${turn}` }),
    );
    for (let tool = 0; tool < 5; tool += 1) {
      events.push(
        event(base + tool * 2 + 1, 'tool.started', {
          toolCallId: `retained-${turn}-${tool}`,
          toolName: tool % 2 === 0 ? 'station-native' : 'external-engine',
        }),
        event(base + tool * 2 + 2, 'tool.completed', {
          toolCallId: `retained-${turn}-${tool}`,
          toolName: tool % 2 === 0 ? 'station-native' : 'external-engine',
          output: seededText(`retained:${turn}:${tool}`, TOOL_OUTPUT_BYTES),
        }),
      );
    }
    events.push(
      event(base + 12, 'turn.completed', { outputText: `done ${turn}` }),
    );
  }
  return events;
}

export function heavyTransferEvents(): CanonicalRuntimeEvent[] {
  const heavyTurn = { turnId: 'transfer-heavy-turn' };
  const events: CanonicalRuntimeEvent[] = [
    event(200, 'turn.started', { prompt: 'heavy transfer turn', ...heavyTurn }),
  ];
  for (let tool = 0; tool < 20; tool += 1) {
    events.push(
      event(201 + tool * 2, 'tool.started', {
        ...heavyTurn,
        toolCallId: `heavy-${tool}`,
        toolName: tool % 2 === 0 ? 'station-native' : 'external-engine',
      }),
      event(202 + tool * 2, 'tool.completed', {
        ...heavyTurn,
        toolCallId: `heavy-${tool}`,
        toolName: tool % 2 === 0 ? 'station-native' : 'external-engine',
        output: seededText(`heavy:${tool}`, TOOL_OUTPUT_BYTES),
      }),
    );
  }
  events.push(
    event(242, 'turn.completed', {
      ...heavyTurn,
      outputText: seededText('heavy:assistant', 4 * 1024),
    }),
  );
  return events;
}

/** The short-gap cursor is deliberately placed before this final large pair. */
export function heavyTransferFinalPair(): CanonicalRuntimeEvent[] {
  return heavyTransferEvents().slice(-3);
}

export function heavyTransferPrefix(): CanonicalRuntimeEvent[] {
  return heavyTransferEvents().slice(0, -3);
}

export function transferFixtureDigest(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: ORCHESTRATION_TRANSFER_FIXTURE_VERSION,
        retained: retainedTransferEvents().map((item) => item.eventId),
        heavy: heavyTransferEvents().map((item) => item.eventId),
      }),
    )
    .digest('hex');
}
