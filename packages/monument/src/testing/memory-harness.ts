import { MemoryKernelVolume, openMemoryKernelStorage } from '../memory.js';
import type { KernelStorageHarness } from './crash-point-store.js';

/** Conformance harness for the in-memory adapter. */
export const memoryKernelHarness: KernelStorageHarness = {
  name: 'memory',
  async createLocation() {
    const volume = new MemoryKernelVolume();
    return {
      async open(options = {}) {
        return openMemoryKernelStorage({
          volume,
          ...(options.participants
            ? { participants: options.participants }
            : {}),
        });
      },
      async dispose() {},
    };
  },
};
