/**
 * The one open request for a session that lives on a connected SSH
 * environment's Station. Rows from `GET /api/environments/ssh/sessions`
 * open here instead of a local chat: this Station holds no copy of that
 * session, only a relayed, read-only history page at a time.
 */
export type RemoteSessionReaderRequest = {
  epoch: number;
  environmentId: string;
  /** This Station's own name for the environment, never the remote's. */
  environmentLabel: string;
  threadId: string;
  title: string;
};

let request: RemoteSessionReaderRequest | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}

export const remoteSessionReaderStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => request,
  open(next: Omit<RemoteSessionReaderRequest, 'epoch'>) {
    request = { ...next, epoch: ++epoch };
    notify();
  },
  close(expected: RemoteSessionReaderRequest) {
    if (request !== expected) return;
    request = null;
    notify();
  },
};
