import type {
  FetchSseMessage,
  FetchSseOptions,
} from '@kontourai/station-sdk/client';

type Listener = Pick<
  FetchSseOptions,
  'onOpen' | 'onMessage' | 'onError' | 'onTerminal' | 'onRetry'
>;
type State = {
  listeners: Set<Listener>;
  phase: 'connecting' | 'open' | 'interrupted' | 'terminal';
  error?: unknown;
  response?: Response;
};
const states = new Map<string, State>();
function stateFor(apiBase: string): State {
  let state = states.get(apiBase);
  if (!state) {
    state = { listeners: new Set(), phase: 'connecting' };
    states.set(apiBase, state);
  }
  return state;
}

/** A detail owns its subscription, never the shared transport or resume cursor. */
export function subscribeSharedOrchestrationStream(
  apiBase: string,
  listener: Listener,
): { close(): void } {
  const state = stateFor(apiBase);
  state.listeners.add(listener);
  // Match fetchSSE's asynchronous callbacks, including late subscribers.
  queueMicrotask(() => {
    if (!state.listeners.has(listener)) return;
    if (state.phase === 'open' && state.response)
      listener.onOpen?.(state.response);
    else if (state.phase === 'interrupted' || state.phase === 'terminal') {
      listener.onError?.(state.error);
      if (state.phase === 'terminal') listener.onTerminal?.(state.error);
    }
  });
  return {
    close: () => {
      state.listeners.delete(listener);
    },
  };
}

export function sharedOrchestrationStreamOpened(
  apiBase: string,
  response: Response,
): void {
  const state = stateFor(apiBase);
  state.phase = 'open';
  state.response = response;
  state.error = undefined;
  for (const listener of state.listeners) listener.onOpen?.(response);
}
export function sharedOrchestrationStreamMessage(
  apiBase: string,
  message: FetchSseMessage,
): void {
  for (const listener of stateFor(apiBase).listeners)
    listener.onMessage(message);
}
export function sharedOrchestrationStreamFailed(
  apiBase: string,
  error: unknown,
  terminal = false,
): void {
  const state = stateFor(apiBase);
  state.phase = terminal ? 'terminal' : 'interrupted';
  state.error = error;
  for (const listener of state.listeners) {
    if (terminal) listener.onTerminal?.(error);
    else listener.onError?.(error);
  }
}
export function sharedOrchestrationStreamRetrying(apiBase: string): void {
  stateFor(apiBase).phase = 'connecting';
  for (const listener of stateFor(apiBase).listeners) listener.onRetry?.();
}
