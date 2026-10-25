import type { ReactNode } from 'react';
import './TaskReviewLayout.css';
import { useIsMobile } from '../../../hooks/useIsMobile';

export function TaskReviewLayout({
  items,
  content,
  comments,
}: {
  items: ReactNode;
  content: ReactNode;
  comments: ReactNode;
}) {
  const mobile = useIsMobile();
  return (
    <section
      className="task-review"
      data-mobile={mobile || undefined}
      aria-label="Task review"
      onKeyDown={(event) => {
        if (
          (event.target as HTMLElement).closest(
            'textarea,input,select,[contenteditable="true"]',
          )
        )
          return;
        if (event.altKey && event.code === 'KeyC') {
          event.preventDefault();
          event.currentTarget
            .querySelector<HTMLButtonElement>('[data-review-send]')
            ?.click();
        } else if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          (event.key === 'j' || event.key === 'k')
        ) {
          const cards = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              '[data-review-thread]',
            ),
          ].filter((card) => !card.closest('[hidden]'));
          const index = cards.findIndex((card) =>
            card.contains(document.activeElement),
          );
          const next =
            index < 0
              ? event.key === 'j'
                ? 0
                : cards.length - 1
              : (index + (event.key === 'j' ? 1 : -1) + cards.length) %
                cards.length;
          if (cards[next]) {
            event.preventDefault();
            cards[next].focus();
            cards[next].scrollIntoView?.({ block: 'nearest' });
          }
        }
      }}
    >
      <div className="task-review__items">{items}</div>
      <div className="task-review__content">{content}</div>
      <div className="task-review__comments">{comments}</div>
      <footer className="review-hotkeys">
        <span>
          <kbd>C</kbd> Comment
        </span>
        <span>
          <kbd>⌥C</kbd> Send
        </span>
        <span>
          <kbd>J/K</kbd> Threads
        </span>
        <span>
          <kbd>Esc</kbd> Discard
        </span>
        <span>
          <kbd>⌘Enter</kbd> Post
        </span>
      </footer>
    </section>
  );
}
