import { PROVIDER_CODEX } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createSenderReopen,
  wireConversationResolutionReopen,
} from '../conversation-resolution-reopen.js';
import { ConversationWorkStateStore } from '../conversation-work-state-store.js';
import { EventBus } from '../event-bus.js';

/**
 * Open and Settled inbox: what reopens a settled conversation on the host.
 * Each case drives the real store through the real bus observer (or the
 * send routes' reopen), with two people who both settled it.
 */

const OWNER = 'personal:owner';
const CAROL = 'human:tailscale-serve:carol';
const SETTLED_AT = '2026-11-01T10:00:00.000Z';
const makeTempDir = trackTempDirs();

let store: ConversationWorkStateStore;
let bus: EventBus;
const warn = vi.fn();

beforeEach(() => {
  store = new ConversationWorkStateStore(makeTempDir('settle-reopen-'));
  store.set(OWNER, 'conversation-1', true, SETTLED_AT);
  store.set(CAROL, 'conversation-1', true, SETTLED_AT);
  store.set(OWNER, 'conversation-2', true, SETTLED_AT);
  bus = new EventBus();
  warn.mockReset();
  wireConversationResolutionReopen(bus, {
    store,
    // `thread-1` is a session of `conversation-1`; any other thread is its
    // own conversation.
    conversationIdOf: (threadId) =>
      threadId === 'thread-1' ? 'conversation-1' : undefined,
    logger: { warn },
  });
});

function publish(event: Partial<CanonicalRuntimeEvent> & { method: string }) {
  bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
    event: {
      eventId: `event-${Math.random()}`,
      provider: 'claude',
      threadId: 'thread-1',
      createdAt: '2026-11-02T10:00:00.000Z',
      turnId: 'turn-1',
      ...event,
    },
  });
}

const settledFor = (person: string) => Object.keys(store.read(person)).sort();

describe('a conversation that needs someone reopens for everyone who settled it', () => {
  test.each<[string, Partial<CanonicalRuntimeEvent> & { method: string }]>([
    [
      'an approval',
      {
        method: 'request.opened',
        requestId: 'request-1',
        requestType: 'approval',
        title: 'Run tests?',
      } as never,
    ],
    [
      'a question',
      {
        method: 'request.opened',
        requestId: 'request-2',
        requestType: 'input',
        blocking: false,
        title: 'Which branch?',
      } as never,
    ],
    ['a failed turn', { method: 'turn.aborted', reason: 'crashed' } as never],
    [
      'a failed engine-opened turn',
      {
        method: 'turn.aborted',
        reason: 'crashed',
        metadata: { trigger: PROVIDER_TURN_TRIGGER },
      } as never,
    ],
    [
      'a turn error',
      { method: 'runtime.error', severity: 'error', message: 'boom' } as never,
    ],
    [
      'a stop',
      { method: 'session.stop-settled', outcome: 'cooperative' } as never,
    ],
  ])('%s', (_label, event) => {
    publish(event);
    expect(settledFor(OWNER)).toEqual(['conversation-2']);
    expect(settledFor(CAROL)).toEqual([]);
  });
});

describe('quiet activity keeps it settled', () => {
  test.each<[string, Partial<CanonicalRuntimeEvent> & { method: string }]>([
    [
      'an engine-opened turn starting',
      {
        method: 'turn.started',
        metadata: { trigger: PROVIDER_TURN_TRIGGER },
      } as never,
    ],
    [
      'an engine-opened turn finishing',
      {
        method: 'turn.completed',
        finishReason: 'stop',
        metadata: { trigger: PROVIDER_TURN_TRIGGER },
      } as never,
    ],
    [
      'a scheduled wake-up finishing normally',
      { method: 'turn.completed', finishReason: 'stop' } as never,
    ],
    [
      "Codex's retriable error, which its next attempt may still answer",
      {
        method: 'runtime.error',
        provider: PROVIDER_CODEX,
        severity: 'error',
        retriable: true,
        message: 'reconnecting',
      } as never,
    ],
    [
      'an answered request',
      {
        method: 'request.resolved',
        requestId: 'request-1',
        status: 'approved',
      } as never,
    ],
  ])('%s', (_label, event) => {
    publish(event);
    expect(settledFor(OWNER)).toEqual(['conversation-1', 'conversation-2']);
    expect(settledFor(CAROL)).toEqual(['conversation-1']);
  });
});

test('a failure reopens a conversation settled under its thread id too', () => {
  store.set(OWNER, 'thread-9', true, SETTLED_AT);
  publish({ method: 'turn.aborted', threadId: 'thread-9' } as never);
  expect(settledFor(OWNER)).toEqual(['conversation-1', 'conversation-2']);
  expect(warn).not.toHaveBeenCalled();
});

describe("the person's own message", () => {
  const reopen = createSenderReopen<{ person?: string }>({
    store: {
      reopen: (...args) => store.reopen(...args),
    },
    personFor: (request) => request.person,
    conversationIdOf: (id) =>
      id === 'thread-1' ? 'conversation-1' : undefined,
    logger: { warn },
  });

  test("clears the sender's record only", () => {
    reopen({ person: OWNER }, 'conversation-1');
    expect(settledFor(OWNER)).toEqual(['conversation-2']);
    expect(settledFor(CAROL)).toEqual(['conversation-1']);
  });

  test('a send naming the thread reopens its conversation', () => {
    reopen({ person: CAROL }, 'thread-1');
    expect(settledFor(CAROL)).toEqual([]);
    expect(settledFor(OWNER)).toEqual(['conversation-1', 'conversation-2']);
  });

  test('a send by no person reopens nothing', () => {
    reopen({}, 'conversation-1');
    expect(settledFor(OWNER)).toEqual(['conversation-1', 'conversation-2']);
    expect(settledFor(CAROL)).toEqual(['conversation-1']);
  });

  test('a store failure is logged and never thrown into the send', () => {
    const failing = createSenderReopen<{ person: string }>({
      store: {
        reopen: () => {
          throw new Error('disk full');
        },
      },
      personFor: (request) => request.person,
      conversationIdOf: () => undefined,
      logger: { warn },
    });
    expect(() => failing({ person: OWNER }, 'conversation-1')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Could not reopen a settled conversation',
      expect.objectContaining({ error: 'disk full' }),
    );
  });
});

test('reopening an open conversation writes nothing', () => {
  expect(store.reopen(['conversation-9'])).toBe(false);
  expect(store.reopen(['conversation-1'], CAROL)).toBe(true);
  expect(store.reopen(['conversation-1'], CAROL)).toBe(false);
});
