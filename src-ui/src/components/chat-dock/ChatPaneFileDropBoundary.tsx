import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { useRef } from 'react';
import { useChatPaneFileDrop } from '../../hooks/useChatPaneFileDrop';

type ChatPaneFileDropBoundaryProps = Omit<
  ComponentPropsWithoutRef<'section'>,
  | 'aria-label'
  | 'onBlurCapture'
  | 'onDragEnd'
  | 'onDragEnter'
  | 'onDragLeave'
  | 'onDragOver'
  | 'onDrop'
  | 'onFocusCapture'
  | 'onMouseEnter'
  | 'onPointerDown'
  | 'onWheel'
> & {
  children: ReactNode;
  enabled: boolean;
  /** Records passive activity on the dock without turning it into an action. */
  onActivity: () => void;
  /** Keeps the shortcut context in sync with focus entering or leaving the pane. */
  onFocusWithinChange: (isFocused: boolean) => void;
  reportError: (message: string | null) => void;
  resetKey: string;
  selectFiles: (files: File[]) => Promise<void>;
};

/** A visible pane accepts files only while its mounted composer owns them. */
export function isChatPaneFileDropEnabled({
  hasAttachmentOwner,
  isPaneOpen,
  isCollapsedDragPreview,
}: {
  hasAttachmentOwner: boolean;
  isPaneOpen: boolean;
  isCollapsedDragPreview: boolean;
}): boolean {
  return hasAttachmentOwner && (isPaneOpen || isCollapsedDragPreview);
}

/** The one production chat-pane root that owns external file drag and drop. */
export function ChatPaneFileDropBoundary({
  children,
  enabled,
  onActivity,
  onFocusWithinChange,
  reportError,
  resetKey,
  selectFiles,
  ...sectionProps
}: ChatPaneFileDropBoundaryProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const drop = useChatPaneFileDrop({
    rootRef,
    enabled,
    reportError,
    resetKey,
    selectFiles,
  });
  return (
    <section
      {...sectionProps}
      aria-label="Chat dock"
      ref={rootRef}
      onMouseEnter={onActivity}
      onFocusCapture={() => {
        onFocusWithinChange(true);
        onActivity();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onFocusWithinChange(false);
        }
      }}
      onPointerDown={onActivity}
      onWheel={onActivity}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDragEnd={drop.onDragEnd}
      onDrop={drop.onDrop}
    >
      {drop.isDraggingFiles && (
        <div
          className="chat-dock__file-drop-overlay"
          data-testid="chat-pane-file-drop-overlay"
          role="status"
          aria-live="polite"
        >
          Drop {drop.fileCount} {drop.fileCount === 1 ? 'file' : 'files'} to
          attach
        </div>
      )}
      {children}
    </section>
  );
}
