// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  dispatchNewChatIntent,
  dockAcceptsNewChatIntent,
  OPEN_NEW_CHAT_EVENT,
  readNewChatIntent,
} from '../newChatIntent';

const listeners: Array<(event: Event) => void> = [];
function listen(listener: (event: Event) => void) {
  listeners.push(listener);
  window.addEventListener(OPEN_NEW_CHAT_EVENT, listener);
}
afterEach(() => {
  for (const listener of listeners.splice(0))
    window.removeEventListener(OPEN_NEW_CHAT_EVENT, listener);
});

const event = (detail: unknown) =>
  new CustomEvent(OPEN_NEW_CHAT_EVENT, { detail });

describe('a dock says whether it took the intent', () => {
  test('with no dock listening the sender is told nobody took it', () => {
    expect(dispatchNewChatIntent({ initialPrompt: 'x' })).toBe(false);
  });

  test('a listener that only reads it has not taken it', () => {
    const read = vi.fn();
    listen(read);
    expect(dispatchNewChatIntent({ initialPrompt: 'x' })).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('a dock that accepts it says so', () => {
    listen((e) => e.preventDefault());
    expect(dispatchNewChatIntent({ initialPrompt: 'x' })).toBe(true);
  });
});

// Review FI-1: Home's starts, selections and hand-offs are the ambient
// dock's; a project-scoped dock must leave every one of them alone.
describe('which dock takes which intent', () => {
  const selection = { context: '__global__', agentSlug: 'a' };
  test.each([
    ['a plain open', {}, true],
    ['a start', { startWithDefault: true }, false],
    ['a selection', { selection }, false],
    ['a hand-off', { handoff: { kind: 'skills' as const } }, false],
    ['an unreadable selection', { selectionInvalid: true }, false],
  ])('a project-scoped dock and %s', (_name, intent, accepted) => {
    expect(dockAcceptsNewChatIntent(intent, true)).toBe(accepted);
  });
  test('the ambient dock takes every intent', () => {
    for (const intent of [
      {},
      { startWithDefault: true },
      { selection },
      { handoff: { kind: 'skills' as const } },
      { selectionInvalid: true },
    ])
      expect(dockAcceptsNewChatIntent(intent, false)).toBe(true);
  });
});

// Review MED-2: a selection that was sent but does not parse must not fall
// back to a default start.
describe('an unreadable selection is said, never started on defaults', () => {
  test.each([
    ['an empty Agent', { context: '__global__', agentSlug: '' }],
    ['an empty context', { context: '' }],
    [
      'an empty provider',
      {
        context: '__global__',
        model: { modelId: 'm', providerId: '', providerOptions: {} },
      },
    ],
    ['a model without options', { context: '__global__', model: {} }],
    ['not an object', 'station'],
  ])('%s', (_name, selection) => {
    const intent = readNewChatIntent(
      event({ startWithDefault: true, initialPrompt: 'Keep me', selection }),
    );
    expect(intent.selection).toBeUndefined();
    expect(intent.selectionInvalid).toBe(true);
    expect(intent.startWithDefault).toBe(false);
    expect(intent.initialPrompt).toBe('Keep me');
  });

  test('a readable selection starts as sent', () => {
    const intent = readNewChatIntent(
      event({
        startWithDefault: true,
        selection: {
          context: 'station',
          agentSlug: 'codex',
          model: { modelId: 'm', providerOptions: { effort: 'high' } },
        },
      }),
    );
    expect(intent.selectionInvalid).toBeUndefined();
    expect(intent.startWithDefault).toBe(true);
    expect(intent.selection).toEqual({
      context: 'station',
      agentSlug: 'codex',
      model: { modelId: 'm', providerOptions: { effort: 'high' } },
    });
  });

  test('the close callback is told how the request ended', () => {
    const onClosed = vi.fn();
    readNewChatIntent(event({ onClosed })).onClosed?.('started');
    expect(onClosed).toHaveBeenCalledWith('started', undefined);
    readNewChatIntent(event({ onClosed })).onClosed?.('dismissed', 'Edited');
    expect(onClosed).toHaveBeenLastCalledWith('dismissed', 'Edited');
  });
});
