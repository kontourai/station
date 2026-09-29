import type { STTOptions, STTProvider, STTState } from '@kontourai/station-sdk';
import { vi } from 'vitest';

/** A registrable STT provider whose state and transcript the test drives. */
export function fakeSTT(id: string, isSupported = true) {
  const listeners = new Set<() => void>();
  const provider = {
    id,
    name: id,
    isSupported,
    state: 'idle' as STTState,
    transcript: '',
    startListening: vi.fn((_opts?: STTOptions) => {
      provider.state = 'listening';
      for (const fn of listeners) fn();
    }),
    stopListening: vi.fn(() => {
      provider.state = 'idle';
      for (const fn of listeners) fn();
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    hear(text: string) {
      provider.transcript = text;
      for (const fn of listeners) fn();
    },
  };
  return provider satisfies STTProvider;
}
