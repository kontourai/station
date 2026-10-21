import { type RefObject, useLayoutEffect, useRef } from 'react';
import type { WorkStatusTone } from '../../views/home/work-status';
import './SessionContextChip.css';

/**
 * The header's way into the session context card while the dock is too
 * narrow to show it beside the transcript. Its word is the inbox row's
 * ladder word for this chat, so it is live without a summary of its own;
 * with no row yet it names the surface it opens.
 */
export function SessionContextChip({
  status,
  triggerRef,
  expanded,
  onOpen,
  onUnmountWhileFocused,
}: {
  status: { word: string; text: string; tone: WorkStatusTone } | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  onOpen: () => void;
  /**
   * The chip is going away (the card it stands in for has room again) while
   * it holds focus; the caller hands focus on. Checked in the layout
   * cleanup, while the button is still in the document.
   */
  onUnmountWhileFocused?: () => void;
}) {
  const unmountWhileFocusedRef = useRef(onUnmountWhileFocused);
  unmountWhileFocusedRef.current = onUnmountWhileFocused;
  useLayoutEffect(() => {
    const button = triggerRef.current;
    return () => {
      if (button && document.activeElement === button)
        unmountWhileFocusedRef.current?.();
    };
  }, [triggerRef]);
  return (
    <button
      ref={triggerRef}
      type="button"
      className="session-context-chip"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={status ? `This chat — ${status.text}` : 'This chat'}
      title={status ? `This chat — ${status.text}` : 'This chat'}
      data-no-dock-drag=""
      data-tone={status?.tone}
      onClick={(event) => {
        // The header row is also the dock's click-to-toggle surface.
        event.stopPropagation();
        onOpen();
      }}
    >
      <span className="session-context-chip__dot" aria-hidden="true" />
      <span className="session-context-chip__word">
        {status ? status.word : 'This chat'}
      </span>
    </button>
  );
}
