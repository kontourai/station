import type { GitStatusResult } from '@kontourai/station-sdk';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import type { ChatSession, FileAttachment } from '../../types';
import { ResponsiveDialogCloseButton } from '../ResponsiveDialogSurface';
import { Empty } from '../state';

export type ActiveWorkPanel = 'files' | 'context';
type VisualViewportStyle = CSSProperties | Record<string, string>;

export function ActiveWorkModalBoundary({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="chat-dock__modal-background"
      inert={active ? true : undefined}
      aria-hidden={active ? true : undefined}
    >
      {children}
    </div>
  );
}

interface ActiveWorkContextFrameProps {
  panel: ActiveWorkPanel;
  isMobile: boolean;
  session: ChatSession;
  gitStatus: GitStatusResult | null | undefined;
  canOpenFiles: boolean;
  visualViewportStyle?: VisualViewportStyle;
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenProjectContext: () => void;
}

export interface ChangedFileEntry {
  displayPath: string;
  editorPath: string | null;
  status: string;
}

/**
 * Git status currently exposes human porcelain lines rather than `-z` records.
 * Display every non-empty path truthfully, but only deep-link the conservative
 * subset that cannot contain quoting, rename delimiters, traversal, or control
 * characters. Ambiguous paths stay visible with navigation disabled.
 */
export function changedFileEntry(change: string): ChangedFileEntry {
  const status = change.slice(0, 2).trim() || 'M';
  const displayPath = (change.length > 3 ? change.slice(3) : change).trim();
  const pathSegments = displayPath.split('/');
  const isTrusted =
    /^[ MADRCUT?!]{2} [A-Za-z0-9._@+/-]+$/.test(change) &&
    !displayPath.startsWith('/') &&
    !displayPath.includes(' -> ') &&
    !pathSegments.includes('..') &&
    pathSegments.every((segment) => segment.length > 0);
  return {
    displayPath: displayPath || change.trim(),
    editorPath: isTrusted ? displayPath : null,
    status,
  };
}

export function collectAttachedContext(session: ChatSession): FileAttachment[] {
  const attached = [
    ...session.attachments,
    ...session.messages.flatMap((message) => message.attachments ?? []),
  ];
  return Array.from(
    new Map(attached.map((attachment) => [attachment.id, attachment])).values(),
  );
}

export function ActiveWorkContextFrame({
  panel,
  isMobile,
  session,
  gitStatus,
  canOpenFiles,
  visualViewportStyle,
  returnFocusTarget,
  onClose,
  onOpenFile,
  onOpenProjectContext,
}: ActiveWorkContextFrameProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  const backdropPointerDismissRef = useRef(false);

  const closeAndRestoreFocus = useCallback(() => {
    const chain = returnFocusRef.current;
    const sheet = sheetRef.current;
    onClose();
    restoreReturnFocus(chain, sheet);
  }, [onClose]);

  const dismissBackdropOnMouseDown = useCallback(() => {
    backdropPointerDismissRef.current = true;
    closeAndRestoreFocus();
  }, [closeAndRestoreFocus]);

  const dismissBackdropOnClick = useCallback(() => {
    if (backdropPointerDismissRef.current) {
      backdropPointerDismissRef.current = false;
      return;
    }
    closeAndRestoreFocus();
  }, [closeAndRestoreFocus]);

  useLayoutEffect(() => {
    if (!isMobile) return;
    returnFocusRef.current = captureReturnFocus(returnFocusTarget);
    const firstControl = sheetRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    firstControl?.focus();
  }, [isMobile, returnFocusTarget]);

  useEffect(() => {
    if (!isMobile) return;
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', containFocus);
    return () => document.removeEventListener('keydown', containFocus);
  }, [closeAndRestoreFocus, isMobile]);

  const attachments = collectAttachedContext(session);
  const panelContent = (
    <aside
      className="active-work-frame"
      aria-label={panel === 'files' ? 'Active work files' : 'Task context'}
    >
      <header className="active-work-frame__header">
        <div>
          <span className="active-work-frame__eyebrow">Active work</span>
          <h2>{panel === 'files' ? 'Changed files' : 'Task context'}</h2>
        </div>
        <ResponsiveDialogCloseButton
          label={`Close ${panel === 'files' ? 'files' : 'task context'}`}
          onClick={isMobile ? closeAndRestoreFocus : onClose}
        />
      </header>

      {panel === 'files' ? (
        <FilesPanel
          gitStatus={gitStatus}
          canOpenFiles={canOpenFiles}
          onOpenFile={(path) => {
            if (isMobile) closeAndRestoreFocus();
            onOpenFile(path);
          }}
        />
      ) : (
        <TaskContextPanel
          session={session}
          gitStatus={gitStatus}
          attachments={attachments}
          onOpenProjectContext={() => {
            if (isMobile) closeAndRestoreFocus();
            onOpenProjectContext();
          }}
        />
      )}
    </aside>
  );

  if (!isMobile) return panelContent;

  return (
    <div
      className="active-work-frame__overlay responsive-surface-overlay"
      style={visualViewportStyle}
    >
      <button
        type="button"
        aria-label={
          panel === 'files'
            ? 'Dismiss active work files'
            : 'Dismiss task context'
        }
        onMouseDown={dismissBackdropOnMouseDown}
        onClick={dismissBackdropOnClick}
        style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        className="active-work-frame__sheet responsive-surface-panel"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={panel === 'files' ? 'Active work files' : 'Task context'}
        style={{ position: 'relative', zIndex: 1 }}
      >
        {panelContent}
      </div>
    </div>
  );
}

function FilesPanel({
  gitStatus,
  canOpenFiles,
  onOpenFile,
}: {
  gitStatus: GitStatusResult | null | undefined;
  canOpenFiles: boolean;
  onOpenFile: (path: string) => void;
}) {
  if (!gitStatus?.isRepo) {
    return (
      <Empty
        variant="compact"
        label="Changed-file status unavailable"
        description="Station could not read a Git working tree for this project."
      />
    );
  }

  if (gitStatus.changes.length === 0) {
    return (
      <Empty
        variant="compact"
        label="Working tree is clean"
        description="Changed files will appear here."
      />
    );
  }

  return (
    <ul className="active-work-frame__files">
      {gitStatus.changes.map((change) => {
        const entry = changedFileEntry(change);
        const canNavigate = canOpenFiles && entry.editorPath !== null;
        return (
          <li key={change}>
            <button
              type="button"
              className="active-work-frame__file"
              disabled={!canNavigate}
              aria-label={
                canNavigate
                  ? `Open ${entry.displayPath} in editor`
                  : `Changed file ${entry.displayPath}`
              }
              onClick={() => {
                if (entry.editorPath) onOpenFile(entry.editorPath);
              }}
              title={
                !canOpenFiles
                  ? 'A coding layout is unavailable for this project'
                  : entry.editorPath === null
                    ? 'Editor navigation is unavailable for this path'
                    : `Open ${entry.displayPath} in editor`
              }
            >
              <span className="active-work-frame__file-status">
                {entry.status}
              </span>
              <span>{entry.displayPath}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TaskContextPanel({
  session,
  gitStatus,
  attachments,
  onOpenProjectContext,
}: {
  session: ChatSession;
  gitStatus: GitStatusResult | null | undefined;
  attachments: FileAttachment[];
  onOpenProjectContext: () => void;
}) {
  return (
    <div className="active-work-frame__context">
      <dl className="active-work-frame__facts">
        <div>
          <dt>Task</dt>
          <dd>{session.title || 'Untitled task'}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{gitStatus?.isRepo ? gitStatus.branch : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Changed files</dt>
          <dd>
            {gitStatus?.isRepo ? gitStatus.changes.length : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>Unavailable</dd>
        </div>
      </dl>

      <section className="active-work-frame__attachments">
        <h3>Attached context</h3>
        {attachments.length === 0 ? (
          <p>Nothing attached.</p>
        ) : (
          <ul>
            {attachments.map((attachment) => (
              <li key={attachment.id}>{attachment.name}</li>
            ))}
          </ul>
        )}
      </section>

      <button
        type="button"
        className="active-work-frame__project-link"
        onClick={onOpenProjectContext}
      >
        Open project context
      </button>
    </div>
  );
}
