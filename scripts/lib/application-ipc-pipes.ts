import type { Readable, Writable } from 'node:stream';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { PionApplicationIpc } from '../../src-server/services/connections/pion-application-ipc.js';

/** Compatibility wrapper; production framing is owned by the connection adapter. */
export function applicationIpcPipes(
  input: Writable,
  output: Readable,
  accept: (channel: ApplicationChannel) => void,
) {
  const ipc = new PionApplicationIpc(input, output, accept);
  return { prepareClose: () => ipc.close(), finish: () => ipc.finish() };
}
