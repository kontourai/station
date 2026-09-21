import {
  type ApplicationChannelTarget,
  createApplicationChannelFetch,
} from './applicationChannel.js';
import type {
  BrowserPionConnectionSnapshot,
  createBrowserPionConnection,
} from './browserPionConnection.js';

type BrowserPionConnection = ReturnType<typeof createBrowserPionConnection>;

export function createSelfHostedApplicationTransport(input: {
  owner: BrowserPionConnection;
  snapshot: BrowserPionConnectionSnapshot;
  applicationOrigin: string;
  signal: AbortSignal;
}): {
  transport: ApplicationChannelTarget['fetch'];
  transportBindingIsCurrent(): boolean;
  close(): void;
} {
  if (new URL(input.applicationOrigin).origin !== input.applicationOrigin)
    throw new Error('Canonical Station application origin required');
  if (input.snapshot.applicationOrigin !== input.applicationOrigin)
    throw new Error('Station browser transport origin mismatch');
  // Owned bounded composition without AbortSignal.any: manual link to caller.
  const lifetime = new AbortController();
  const parent = input.signal;
  if (parent.aborted) lifetime.abort(parent.reason ?? new Error('cancelled'));
  const onParent = () =>
    lifetime.abort(parent.reason ?? new Error('cancelled'));
  parent.addEventListener('abort', onParent, { once: true });
  const signal = lifetime.signal;
  let current = true;
  const transport = createApplicationChannelFetch({
    origin: input.applicationOrigin,
    signal,
    open: (openSignal) =>
      input.owner.openApplicationChannel(input.snapshot, openSignal),
    assertCurrent: async () => {
      if (
        !current ||
        signal.aborted ||
        !(await input.owner.isCurrent(input.snapshot))
      )
        throw new Error('Station browser transport retired');
    },
  });
  return Object.freeze({
    transport,
    transportBindingIsCurrent: () => current && !signal.aborted,
    close() {
      if (!current) return;
      current = false;
      lifetime.abort(new Error('Station browser transport retired'));
      parent.removeEventListener('abort', onParent);
    },
  });
}
