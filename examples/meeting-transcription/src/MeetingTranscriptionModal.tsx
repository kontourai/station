/**
 * MeetingTranscriptionModal (plugin version) — uses useSTT() from the SDK
 * instead of the WebSpeech API directly.
 *
 * This means it works with any registered STT provider (WebSpeech, ElevenLabs, etc.)
 */

import { useSTT } from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  isOpen: boolean;
  onSend: (prompt: string) => void;
  onClose: () => void;
}

export function MeetingTranscriptionModal({ isOpen, onSend, onClose }: Props) {
  const stt = useSTT();
  const [finalTranscript, setFinalTranscript] = useState('');
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Capture transcript changes from STT provider
  useEffect(() => {
    if (stt.transcript && running) {
      setFinalTranscript((prev) => `${prev + stt.transcript} `);
    }
  }, [stt.transcript, running]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Start when modal opens
  useEffect(() => {
    if (isOpen && stt.supported && !running) {
      setFinalTranscript('');
      setRunning(true);
      stt.startListening({ continuous: true, interimResults: true });
    }
    if (!isOpen && running) {
      stt.stopListening();
      setRunning(false);
    }
  }, [isOpen, running, stt.startListening, stt.stopListening, stt.supported]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback(() => {
    stt.stopListening();
    setRunning(false);
    setFinalTranscript('');
    onClose();
  }, [stt, onClose]);

  const handleSend = useCallback(() => {
    const text = finalTranscript.trim();
    if (!text) return;
    const prompt = `Here is a meeting transcript. Please extract the key action items, decisions made, and any important points:\n\n${text}`;
    onSend(prompt);
    handleClose();
  }, [finalTranscript, onSend, handleClose]);

  const handleSendRaw = useCallback(() => {
    const text = finalTranscript.trim();
    if (!text) return;
    onSend(text);
    handleClose();
  }, [finalTranscript, onSend, handleClose]);

  if (!isOpen) return null;

  const isListening = stt.state === 'listening';
  const hasContent = !!finalTranscript;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is a pointer-only redundancy of the visible Close button; keyboard users dismiss via that button
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — the keyboard affordance is the Close button, not the backdrop
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 560,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid var(--border-primary)',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {isListening && (
              <>
                <style>{`@keyframes rec-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: 'var(--color-error,#ef4444)',
                    animation: 'rec-blink 1.2s ease-in-out infinite',
                    flexShrink: 0,
                  }}
                />
              </>
            )}
            <span style={{ fontWeight: 600, fontSize: 15 }}>
              {isListening ? 'Recording…' : 'Transcript'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running ? (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  stt.stopListening();
                  setRunning(false);
                }}
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  setRunning(true);
                  stt.startListening({
                    continuous: true,
                    interimResults: true,
                  });
                }}
                disabled={!stt.supported}
              >
                Resume
              </button>
            )}
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => setFinalTranscript('')}
              disabled={!hasContent}
            >
              Clear
            </button>
            <button
              type="button"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                fontSize: 18,
                padding: '0 4px',
              }}
              onClick={handleClose}
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '14px 16px',
            minHeight: 200,
            fontSize: 14,
            lineHeight: 1.7,
            color: 'var(--text-primary)',
          }}
        >
          {!hasContent && !isListening && (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              {stt.supported
                ? 'Press Resume to start recording…'
                : 'Speech recognition not supported.'}
            </div>
          )}
          {!hasContent && isListening && (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Listening… speak now.
            </div>
          )}
          {finalTranscript && <span>{finalTranscript}</span>}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border-primary)',
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={handleSendRaw}
            disabled={!hasContent}
          >
            Send as message
          </button>
          <button
            type="button"
            className="button button--primary button--small"
            onClick={handleSend}
            disabled={!hasContent}
          >
            Extract action items
          </button>
        </div>
      </div>
    </div>
  );
}
