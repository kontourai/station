/**
 * A {@link TerminalSession} from the SDK terminal session store, as the
 * narrow {@link TerminalViewSession} a terminal view renders.
 */

import type { TerminalSession } from '../client/terminal-session-store';
import type {
  TerminalViewSession,
  TerminalViewSessionListener,
  TerminalViewSessionState,
} from './session';

function viewState(session: TerminalSession): TerminalViewSessionState {
  // The program ending outranks the connection: an exited shell stays exited.
  if (session.status === 'exited' || session.status === 'failed')
    return 'exited';
  switch (session.state) {
    case 'connecting':
      return 'connecting';
    case 'replaying':
      return 'replaying';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'reconnecting':
    case 'detached':
      return 'disconnected';
  }
}

export function toTerminalViewSession(
  session: TerminalSession,
): TerminalViewSession {
  const decoder = new TextDecoder();
  return {
    get state() {
      return viewState(session);
    },
    get readOnly() {
      return session.readOnly;
    },
    subscribe(listener: TerminalViewSessionListener) {
      // The store hands a late subscriber its retained output synchronously
      // from subscribe(): that output predates this view, so it is replay
      // and its queries must not be answered again.
      let catchingUp = true;
      const unsubscribe = session.subscribe({
        output: (data) =>
          listener.output(
            data,
            catchingUp || session.state === 'replaying' ? 'replay' : 'live',
          ),
        reset: () => listener.reset?.(),
        change: (current) =>
          listener.state?.(viewState(current), current.error?.message),
      });
      catchingUp = false;
      listener.state?.(viewState(session), session.error?.message);
      return unsubscribe;
    },
    write(bytes) {
      // Encoder output is UTF-8; the store carries input as text.
      return session.write(decoder.decode(bytes));
    },
    resize(cols, rows) {
      session.resize(cols, rows);
    },
  };
}
