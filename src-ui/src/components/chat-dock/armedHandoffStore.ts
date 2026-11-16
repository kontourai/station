import { useSyncExternalStore } from 'react';
import type { ArmedConversationHandoff } from './ConversationHandoffDialog';

/**
 * Where an armed send stands once it leaves the composer: `sending` while it
 * dispatches unseen, `attention` while its dialog needs the person (a refusal
 * or an outcome to check). Absent: nothing is in flight.
 */
export type ArmedHandoffPhase = 'sending' | 'attention';

interface Entry {
  armed: ArmedConversationHandoff | null;
  phase?: ArmedHandoffPhase;
}

/**
 * The Agent/engine picked for a conversation's next message, and whether that
 * send is in flight, held per Station and conversation rather than per pane:
 * two panes showing one conversation read one choice, so neither can send
 * the draft the ordinary way while the other's handoff runs. In memory only;
 * nothing is sent when a choice is made, so a reload simply forgets it.
 */
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Entry = { armed: null };

export function armedHandoffKey(apiBase: string, conversationId: string) {
  return `${apiBase}\0${conversationId}`;
}

function write(key: string, next: Entry) {
  if (!next.armed && !next.phase) entries.delete(key);
  else entries.set(key, next);
  for (const listener of listeners) listener();
}

export const armedHandoffStore = {
  get(key: string): Entry {
    return entries.get(key) ?? EMPTY;
  },
  /** Arm, replace, or (after a receipt) clear the choice. */
  setArmed(key: string, armed: ArmedConversationHandoff | null) {
    write(key, { ...armedHandoffStore.get(key), armed });
  },
  /**
   * The person's Undo. Refused while the send is in flight: the draft is
   * still in the composer, and sending it the ordinary way then would send
   * it twice.
   */
  undo(key: string): boolean {
    const entry = armedHandoffStore.get(key);
    if (entry.phase) return false;
    write(key, { ...entry, armed: null });
    return true;
  },
  setPhase(key: string, phase: ArmedHandoffPhase | undefined) {
    const entry = armedHandoffStore.get(key);
    if (entry.phase === phase) return;
    write(key, { ...entry, phase });
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Test-only reset. */
  clear() {
    entries.clear();
    for (const listener of listeners) listener();
  },
};

export function useArmedHandoffEntry(key: string | undefined): Entry {
  return useSyncExternalStore(armedHandoffStore.subscribe, () =>
    key ? armedHandoffStore.get(key) : EMPTY,
  );
}
