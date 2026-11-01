/// <reference lib="webworker" />
/**
 * Worker entry: the emulator runs here so parsing a flood of output never
 * blocks input, layout or painting on the UI thread.
 */

import { EngineHost } from './engine-host';
import type { EngineRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const host = new EngineHost((event, transfer) =>
  scope.postMessage(event, transfer ?? []),
);

scope.onmessage = (message: MessageEvent<EngineRequest>) => {
  void host.handle(message.data);
};
