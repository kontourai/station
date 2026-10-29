import { useLayoutEffect, useRef } from 'react';
import { prefersInstantScroll } from './animateScrollToBottom';

interface ScrollToBottomButtonProps {
  onClick: () => void;
}

const FADE_IN_MS = 150;

export function ScrollToBottomButton({ onClick }: ScrollToBottomButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Fades in rather than popping, through the Web Animations API (no
  // stylesheet owns this). It leaves without a fade: on a phone its row in
  // the composer exists only while it does, so the transcript grows when it
  // goes, and that resize must land at the start of the glide, while the
  // transcript is far from its end, not part-way through it.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button || typeof button.animate !== 'function') return;
    if (prefersInstantScroll()) return;
    button.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FADE_IN_MS,
      easing: 'ease-out',
    });
  }, []);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="chat-scroll-to-bottom"
      onClick={onClick}
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d="M8 3v10m-4-4 4 4 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
