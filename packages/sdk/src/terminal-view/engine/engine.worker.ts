/// <reference lib="webworker" />
/**
 * Worker entry: the emulator runs here so parsing a flood of output never
 * blocks input, layout or painting on the UI thread.
 */

import { EngineHost } from './engine-host';
import type { EngineRequest } from './protocol';

// This module only ever runs as a dedicated worker, where the global `self`
// is the worker scope; the module-local declaration gives it that type.
declare const self: DedicatedWorkerGlobalScope;

const host = new EngineHost((event, transfer) =>
  self.postMessage(event, transfer ?? []),
);

self.onmessage = (message: MessageEvent<EngineRequest>) => {
  void host.handle(message.data);
};
