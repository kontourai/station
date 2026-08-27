/**
 * GlobalVoiceButton — floating mic button accessible from any view.
 *
 * Rendered at app root level (above ChatDock). On mobile: fixed bottom-right FAB.
 * On desktop: compact inline button.
 *
 * Transcription is routed to the first non-busy chat session via useSendMessage.
 * Returns null when voice is not supported in this browser.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { useAllActiveChats } from '../../contexts/ActiveChatsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useSendMessage } from '../../hooks/useActiveChatSessions';
import { useSTT } from '../../hooks/useSTT';
import './GlobalVoiceButton.css';

const isMobile = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(max-width: 768px)').matches;

export function GlobalVoiceButton() {
  const stt = useSTT();
  const { apiBase } = useApiBase();
  const activeChats = useAllActiveChats();
  const sendMessage = useSendMessage(apiBase);
  const transcriptRef = useRef('');

  // Accumulate transcript while listening; send on idle (mobile only)
  useEffect(() => {
    if (!isMobile()) return;
    if (stt.state === 'listening' && stt.transcript) {
      transcriptRef.current = stt.transcript;
    } else if (stt.state === 'idle' && transcriptRef.current) {
      const text = transcriptRef.current.trim();
      transcriptRef.current = '';
      if (!text) return;

      // Find first non-busy session (keyed by sessionId)
      const entries = Object.entries(activeChats);
      const entry =
        entries.find(([, s]) => s.status !== 'sending') ?? entries[0];
      if (!entry) return;
      const [sessionId, session] = entry;
      sendMessage(
        sessionId,
        session.agentSlug ?? '',
        session.conversationId,
        text,
      );
    }
  }, [stt.state, stt.transcript, activeChats, sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      transcriptRef.current = '';
      stt.startListening();
    },
    [stt],
  );

  const handlePointerUp = useCallback(() => {
    stt.stopListening();
  }, [stt]);

  if (!stt.supported) return null;
  if (!isMobile()) return null;

  const isListening = stt.state === 'listening';
  const isError = stt.state === 'error';
  const mobile = isMobile();

  const className = [
    'gvb',
    mobile ? 'gvb--mobile' : 'gvb--desktop',
    isListening ? 'gvb--listening' : '',
    isError ? 'gvb--error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      data-testid="global-voice-button"
      aria-label={isListening ? 'Release to send' : 'Hold to speak (global)'}
      title={isListening ? 'Release to send' : 'Hold to speak'}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {isListening && mobile && <span className="gvb__pulse" aria-hidden />}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path
          d="M5 11a7 7 0 0 0 14 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <line
          x1="12"
          y1="18"
          x2="12"
          y2="22"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="22"
          x2="16"
          y2="22"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
