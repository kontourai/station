import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import './FullScreen.css';
import { errorQuips, loadingPhrases, loadingTips } from './phrases';

/* ── Spinner (unchanged) ── */
const spinnerKeyframes = `@keyframes wa-spin { to { transform: rotate(360deg) } }`;
let styleInjected = false;
function injectStyles() {
  if (styleInjected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.textContent = [
    spinnerKeyframes,
    `@keyframes wa-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`,
  ].join('\n');
  document.head.appendChild(s);
  styleInjected = true;
}

const sizes = { sm: 10, md: 16, lg: 24 } as const;

export function Spinner({
  size = 'md',
  color,
}: {
  size?: 'sm' | 'md' | 'lg';
  color?: string;
}) {
  injectStyles();
  const px = sizes[size];
  const bw = size === 'sm' ? 1.5 : 2;
  return (
    <span
      className="station-spinner"
      style={{
        display: 'inline-block',
        width: px,
        height: px,
        borderRadius: '50%',
        border: `${bw}px solid var(--border-primary, #333)`,
        borderTopColor: color || 'var(--accent-primary, #4a9eff)',
        animation:
          'wa-spin var(--motion-status-spin, 0.8s) var(--ease-linear, linear) infinite',
        flexShrink: 0,
      }}
    />
  );
}

/* ── LoadingState (inline, unchanged) ── */
export function LoadingState({
  message = 'Loading...',
  size = 'md',
}: {
  message?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: size === 'sm' ? '0.4rem' : '0.5rem',
        padding: size === 'sm' ? '0.75rem' : '2rem',
        color: 'var(--text-secondary, #999)',
        fontSize: size === 'sm' ? '0.8rem' : '0.85rem',
      }}
    >
      <Spinner size={size === 'sm' ? 'sm' : 'md'} />
      <span>{message}</span>
    </div>
  );
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── FullScreenLoader ── */

/** Keeps a caller's fraction inside 0..1 so the bar can never render past its track. */
function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function FullScreenLoader({
  message,
  phrases = loadingPhrases,
  tipMessages = loadingTips,
  interval = 2500,
  showLogo = true,
  label,
  action,
  progress,
}: {
  message?: string;
  phrases?: string[];
  tipMessages?: string[];
  interval?: number;
  showLogo?: boolean;
  label?: string;
  /**
   * Optional escape hatch rendered below the progress bar. A loading screen
   * with no action is only honest while the wait is bounded by something the
   * user can see; when it isn't, a spinner is indistinguishable from a wedge.
   * Callers that can offer a retry or a way out should pass one.
   */
  action?: ReactNode;
  /**
   * Determinate progress, 0..1. Omit for the default indeterminate bar —
   * pass a number ONLY when the wait is bounded by something real and
   * measurable (station#1876: a pairing request's own expiry). A fabricated
   * fraction is worse than an honest spinner, because it promises the user a
   * completion time the code cannot actually predict.
   */
  progress?: number;
}) {
  const [shuffledPhrases] = useState(() => shuffled(phrases));
  const [shuffledTips] = useState(() => shuffled(tipMessages));
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [tipIdx, setTipIdx] = useState(0);
  const [fading, setFading] = useState(false);

  const cycle = useCallback(() => {
    setFading(true);
    setTimeout(() => {
      setPhraseIdx((i) => (i + 1) % shuffledPhrases.length);
      setTipIdx((i) => (i + 1) % shuffledTips.length);
      setFading(false);
    }, 350);
  }, [shuffledPhrases.length, shuffledTips.length]);

  useEffect(() => {
    if (message) return;
    const id = setInterval(cycle, interval);
    return () => clearInterval(id);
  }, [message, interval, cycle]);

  const displayText = message || shuffledPhrases[phraseIdx];
  const displayTip = shuffledTips[tipIdx];

  return (
    <div className="fs-screen">
      <div className="fs-screen__inner">
        {showLogo && (
          <div className="fs-logo-wrap">
            <div className="fs-logo-glow" />
            <div className="fs-logo-ring" />
            <img src="/favicon.png" alt="" className="fs-logo" />
          </div>
        )}
        {label && <div className="fs-label">{label}</div>}
        <div className="fs-messages">
          <div className="fs-message-primary" data-fading={fading}>
            {displayText}
          </div>
          {!message && tipMessages.length > 0 && (
            <div className="fs-message-tip" data-fading={fading}>
              {displayTip}
            </div>
          )}
        </div>
        <div
          className="fs-progress-track"
          {...(progress === undefined
            ? {}
            : {
                role: 'progressbar',
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': Math.round(clampFraction(progress) * 100),
                'aria-label': label ?? displayText,
              })}
        >
          <div
            className="fs-progress-bar"
            {...(progress === undefined
              ? {}
              : {
                  'data-determinate': 'true',
                  style: { width: `${clampFraction(progress) * 100}%` },
                })}
          />
        </div>
        {action && (
          // aria-live: these appear several seconds into an already-rendered
          // screen. Without an announcement a screen-reader user has no cue
          // that controls now exist, and would have to tab into what was
          // empty space to find them. No role= here — a group without an
          // accessible name buys nothing, and the a11y ratchet counts it as a
          // useSemanticElements violation.
          <div className="fs-actions fs-loader-actions" aria-live="polite">
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── FullScreenError ── */

/**
 * A single error affordance. When `actions` is provided it fully replaces the
 * existing `onRetry`/`secondaryAction` buttons, letting a caller render an
 * arbitrary set (e.g. the desktop failed-supervisor screen's Restart / View log
 * / Connect-to-a-remote-host trio). Those props stay untouched for every
 * existing caller.
 */
export interface FullScreenErrorAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

/**
 * Collapsed, truncated monospace block for a diagnostic tail (e.g. the bundled
 * server's stderr) plus the log path. Styled inline so this SDK component pulls
 * in no extra dependency or stylesheet beyond FullScreen.css.
 */
const errorDetailStyle: CSSProperties = {
  maxWidth: '100%',
  maxHeight: 160,
  overflow: 'auto',
  textAlign: 'left',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: '0.75rem 0 0',
  padding: '0.6rem 0.75rem',
  borderRadius: 8,
  background: 'rgba(0,0,0,0.28)',
  color: 'var(--text-secondary, #999)',
};

export function FullScreenError({
  title = 'Something went wrong',
  description,
  detail,
  onRetry,
  retryLabel = 'Try Again',
  secondaryAction,
  actions,
  showLogo = true,
}: {
  title?: string;
  description?: string;
  /** Optional diagnostic tail (stderr, log path) rendered monospace. */
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: { label: string; onClick: () => void };
  /** When provided, replaces the onRetry/secondaryAction button pair. */
  actions?: FullScreenErrorAction[];
  showLogo?: boolean;
}) {
  const [quip] = useState(
    () => errorQuips[Math.floor(Math.random() * errorQuips.length)],
  );

  return (
    <div className="fs-screen fs-screen--error">
      <div className="fs-screen__inner">
        {showLogo && (
          <div className="fs-logo-wrap">
            <div className="fs-logo-glow" />
            <div className="fs-logo-ring" />
            <img src="/favicon.png" alt="" className="fs-logo" />
          </div>
        )}
        <h2 className="fs-error-title">{title}</h2>
        {description && <p className="fs-error-desc">{description}</p>}
        {detail && <pre style={errorDetailStyle}>{detail}</pre>}
        <div className="fs-error-actions">
          {actions ? (
            actions.map((action) => (
              <button
                type="button"
                key={action.label}
                className={`fs-btn fs-btn--${action.variant ?? 'secondary'}`}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))
          ) : (
            <>
              {onRetry && (
                <button
                  type="button"
                  className="fs-btn fs-btn--primary"
                  onClick={onRetry}
                >
                  {retryLabel}
                </button>
              )}
              {secondaryAction && (
                <button
                  type="button"
                  className="fs-btn fs-btn--secondary"
                  onClick={secondaryAction.onClick}
                >
                  {secondaryAction.label}
                </button>
              )}
            </>
          )}
        </div>
        <div className="fs-error-quip">{quip}</div>
      </div>
    </div>
  );
}
