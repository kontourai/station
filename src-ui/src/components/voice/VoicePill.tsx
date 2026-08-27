import { useVoiceSession } from '../../hooks/useVoiceSession';
import { CloseGlyph } from '../icons/Glyph';
import './VoicePill.css';

function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
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
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getIcon(state: string) {
  switch (state) {
    case 'speaking':
      return <SpeakerIcon />;
    case 'thinking':
    case 'connecting':
      return <SpinnerIcon />;
    default:
      return <MicIcon />;
  }
}

export function VoicePill() {
  const {
    state,
    transcript,
    connect,
    disconnect,
    isMuted,
    toggleMute,
    error,
    audioLevel,
  } = useVoiceSession();
  const isActive = state !== 'idle';

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: composite voice control contains an independent mute button, so it cannot itself be a native button. */}
      <div
        data-testid="voice-pill"
        className={`voice-pill${isActive ? ` voice-pill--${state}` : ''}`}
        style={
          state === 'listening'
            ? ({
                '--audio-scale': 1 + audioLevel * 0.3,
                '--audio-glow': audioLevel,
              } as React.CSSProperties)
            : undefined
        }
        onClick={isActive ? disconnect : connect}
        title={
          error ?? (isActive ? 'End voice session' : 'Start voice session')
        }
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        {state === 'listening' && <span className="voice-pill__ring" />}
        <span className="voice-pill__icon">{getIcon(state)}</span>
        {isActive && isMuted && (
          <button
            type="button"
            className="voice-pill__mute"
            onClick={(e) => {
              e.stopPropagation();
              toggleMute();
            }}
            title="Unmute"
          >
            <CloseGlyph />
          </button>
        )}
        {isActive && transcript && (
          <div className="voice-pill__transcript voice-pill__transcript--visible">
            {transcript}
          </div>
        )}
      </div>
    </>
  );
}
