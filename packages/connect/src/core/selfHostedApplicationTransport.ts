import {
  createApplicationChannelFetch,
  type ApplicationChannelTarget,
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
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
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
      lifetime.abort();
    },
  });
}

