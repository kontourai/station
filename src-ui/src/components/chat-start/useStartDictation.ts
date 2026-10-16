import { useEffect, useEffectEvent } from 'react';
import { useOptionalSTT } from '../../hooks/useSTT';
import type { StartComposerVoice } from './StartComposer';

/**
 * The start composer's mic: the chat composer's dictation, delivering each
 * finished transcript to `onTranscript`. Undefined (no mic) outside the voice
 * provider. `useSTT` gives the transcript only to the composer that started
 * listening, so a dictation here never also lands in an open chat's draft.
 */
export function useStartDictation(
  onTranscript: (text: string) => void,
): StartComposerVoice | undefined {
  const stt = useOptionalSTT();
  const deliver = useEffectEvent(onTranscript);
  const state = stt?.state;
  const transcript = stt?.transcript;
  useEffect(() => {
    if (state === 'idle' && transcript) deliver(transcript);
  }, [state, transcript]);
  if (!stt) return undefined;
  return {
    state: stt.state,
    supported: stt.supported,
    unsupportedReason: stt.unsupportedReason,
    error: stt.errorMessage,
    onStart: () => stt.startListening(),
    onStop: () => stt.stopListening(),
  };
}

/** Append dictated text to a draft the way the chat composer does. */
export function appendDictation(current: string, text: string): string {
  return current ? `${current} ${text}` : text;
}
