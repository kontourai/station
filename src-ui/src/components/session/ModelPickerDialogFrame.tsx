import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { ResponsiveDialogHeader } from '../ResponsiveDialogSurface';

/**
 * Eager shell for both the rich model-picker chunk and its loading states.
 * Keeping this boundary outside React.lazy means opening the control always
 * creates a nested dialog that owns focus, Escape, dismissal, and return
 * focus; only the catalog body is allowed to arrive later.
 */
export function ModelPickerDialogFrame({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const containFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (controls.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
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

  useEffect(() => {
    const previouslyFocused = captureReturnFocus();
    const panel = panelRef.current;
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        onCloseRef.current();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      window.matchMedia('(max-width: 768px)').matches
        ? 'button:not(:disabled), input:not(:disabled), select:not(:disabled)'
        : 'input:not(:disabled), button:not(:disabled)',
    );
    focusable?.focus();
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      restoreReturnFocus(previouslyFocused, panel);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className="session-model-picker"
      role="dialog"
      aria-label="Choose model"
      tabIndex={-1}
      onKeyDownCapture={containFocus}
    >
      <ResponsiveDialogHeader
        title="Model"
        subtitle="For this chat · Favorites stay on this device"
        closeLabel="Close model picker"
        onClose={onClose}
      />
      {children}
    </div>
  );
}
