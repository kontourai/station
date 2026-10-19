import { type Ref, useRef, useState } from 'react';
import { downloadDesktopUpdate } from '../../platform/native/desktopUpdate';
import { glyph, RefreshGlyph, WarningGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import {
  type DesktopUpdateControlView,
  desktopUpdateControlView,
} from './desktopUpdatePresentation';
import { useDesktopUpdateState } from './useDesktopUpdateState';
import './DesktopUpdate.css';

const DownloadGlyph = /* @__PURE__ */ glyph(
  'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
);

const loadRestartDialog = () =>
  import('./DesktopUpdateRestartDialog').then((module) => ({
    default: module.DesktopUpdateRestartDialog,
  }));

/** A determinate ring for a known percent, an indeterminate spin otherwise. */
export function ProgressRing({ percent }: { percent: number | null }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      aria-hidden="true"
      className={`desktop-update-ring${percent === null ? ' desktop-update-ring--indeterminate' : ''}`}
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
    >
      <circle className="desktop-update-ring__track" cx="8" cy="8" r={radius} />
      <circle
        className="desktop-update-ring__value"
        cx="8"
        cy="8"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={
          percent === null
            ? circumference * 0.7
            : circumference * (1 - percent / 100)
        }
      />
    </svg>
  );
}

/**
 * The control itself, for every visible state. Collapsed (icon-only) keeps
 * the same accessible name and puts the label in the tooltip.
 */
export function DesktopUpdateControlButton({
  view,
  collapsed = false,
  onDownload,
  onRestart,
  restartRef,
}: {
  view: DesktopUpdateControlView;
  collapsed?: boolean;
  onDownload: () => void;
  onRestart: () => void;
  restartRef?: Ref<HTMLButtonElement>;
}) {
  const className = `desktop-update-control${collapsed ? ' desktop-update-control--collapsed' : ''}`;
  switch (view.kind) {
    case 'hidden':
      return null;
    case 'download': {
      const label = view.failed ? 'Retry download' : 'Download update';
      const title = view.failed
        ? `The download of Station ${view.version} failed. Retry it.`
        : `Station ${view.version} is available. Download it now; nothing restarts until you choose to.`;
      return (
        <button
          type="button"
          className={`${className}${view.failed ? ' desktop-update-control--failed' : ''}`}
          aria-label={`${label}: Station ${view.version}`}
          title={title}
          onClick={onDownload}
        >
          {view.failed ? <WarningGlyph /> : <DownloadGlyph />}
          {!collapsed && <span>{label}</span>}
        </button>
      );
    }
    case 'downloading':
      return (
        <div
          className={className}
          role="progressbar"
          aria-label={`Downloading Station ${view.version}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent ?? undefined}
          aria-valuetext={view.progressText}
          title={`Downloading Station ${view.version}: ${view.progressText}`}
        >
          <ProgressRing percent={view.percent} />
          {!collapsed && <span>Downloading {view.progressText}</span>}
        </div>
      );
    case 'restart':
      return (
        <button
          ref={restartRef}
          type="button"
          className={`${className} desktop-update-control--ready${view.failed ? ' desktop-update-control--failed' : ''}`}
          aria-label={`Restart to update to Station ${view.version}`}
          aria-haspopup="dialog"
          title={
            view.failed
              ? `Installing Station ${view.version} failed. Restart to try again.`
              : `Station ${view.version} is downloaded. Restart to install it.`
          }
          onClick={onRestart}
        >
          {view.failed ? <WarningGlyph /> : <RefreshGlyph />}
          {!collapsed && <span>Restart to update</span>}
        </button>
      );
    case 'installing':
      return (
        <div
          className={className}
          role="status"
          title={`Installing Station ${view.version}`}
        >
          <ProgressRing percent={null} />
          {!collapsed && <span>Installing update…</span>}
        </div>
      );
  }
}

/**
 * The always-visible app-chrome update control (#3851). Hidden unless there
 * is something to do or watch: an available update offers Download, a
 * download shows its progress, a downloaded update offers Restart, which
 * only opens the confirmation. Desktop only; the parent mounts it there.
 */
export function DesktopUpdateControl({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const { state } = useDesktopUpdateState(true);
  const view = desktopUpdateControlView(state);
  const [confirming, setConfirming] = useState(false);
  const restartRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <DesktopUpdateControlButton
        view={view}
        collapsed={collapsed}
        restartRef={restartRef}
        onDownload={() => {
          downloadDesktopUpdate().catch((error: unknown) => {
            console.warn(
              'station: desktop update download request failed',
              error,
            );
          });
        }}
        onRestart={() => setConfirming(true)}
      />
      {confirming && state && (
        <LazyBoundary
          load={loadRestartDialog}
          pending={null}
          componentProps={{
            state,
            onClose: () => setConfirming(false),
            returnFocusTarget: restartRef.current,
          }}
        />
      )}
    </>
  );
}
