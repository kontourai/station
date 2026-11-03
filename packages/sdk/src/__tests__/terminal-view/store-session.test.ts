import { describe, expect, it } from 'vitest';
import type {
  TerminalSession,
  TerminalSessionListener,
} from '../../client/terminal-session-store';
import { toTerminalViewSession } from '../../terminal-view/store-session';

/** A store session with retained output, driven by the test. */
function fakeSession(retained: string[]) {
  const listeners = new Set<TerminalSessionListener>();
  const written: string[] = [];
  const session = {
    terminalId: 'id',
    target: { projectId: 'p', bindingKey: 'project' },
    state: 'ready' as TerminalSession['state'],
    status: 'running' as TerminalSession['status'],
    readOnly: false,
    error: undefined,
    subscribe(listener: TerminalSessionListener) {
      listeners.add(listener);
      retained.forEach((text, i) =>
        listener.output?.(new TextEncoder().encode(text), i + 1),
      );
      return () => listeners.delete(listener);
    },
    write: (data: string) => {
      written.push(data);
      return true;
    },
    resize: () => undefined,
    cwd: async () => null,
    close: async () => undefined,
    detach: () => undefined,
  } satisfies TerminalSession;
  const emit = (text: string) => {
    for (const listener of listeners)
      listener.output?.(new TextEncoder().encode(text), 99);
  };
  const change = (
    patch: Partial<Pick<TerminalSession, 'state' | 'status'>>,
  ) => {
    Object.assign(session, patch);
    for (const listener of listeners) listener.change?.(session);
  };
  return { session, emit, change, written };
}

describe('toTerminalViewSession', () => {
  it('marks retained output handed over at subscribe as replay, later output as live', () => {
    const { session, emit } = fakeSession(['old \x1b[c']);
    const seen: [string, string][] = [];
    toTerminalViewSession(session).subscribe({
      output: (bytes, kind) =>
        seen.push([new TextDecoder().decode(bytes), kind]),
    });
    emit('new');
    expect(seen).toEqual([
      ['old \x1b[c', 'replay'],
      ['new', 'live'],
    ]);
  });

  it('marks output that arrives while the store replays as replay', () => {
    const { session, emit, change } = fakeSession([]);
    const kinds: string[] = [];
    toTerminalViewSession(session).subscribe({
      output: (_bytes, kind) => kinds.push(kind),
    });
    change({ state: 'replaying' });
    emit('resumed');
    change({ state: 'ready' });
    emit('live');
    expect(kinds).toEqual(['replay', 'live']);
  });

  it('reports an exited program over the connection state', () => {
    const { session, change } = fakeSession([]);
    const states: string[] = [];
    const view = toTerminalViewSession(session);
    view.subscribe({ output: () => undefined, state: (s) => states.push(s) });
    change({ state: 'reconnecting' });
    change({ status: 'exited' });
    expect(states).toEqual(['ready', 'disconnected', 'exited']);
    expect(view.state).toBe('exited');
  });

  it('sends encoded input to the store as text', () => {
    const { session, written } = fakeSession([]);
    toTerminalViewSession(session).write(new TextEncoder().encode('ls é\r'));
    expect(written).toEqual(['ls é\r']);
  });
});
