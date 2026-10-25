import type { ReactNode } from 'react';
import './TaskReviewLayout.css';

export function TaskReviewLayout({
  items,
  content,
  comments,
}: {
  items: ReactNode;
  content: ReactNode;
  comments: ReactNode;
}) {
  return (
    <section className="task-review" aria-label="Task review">
      <div className="task-review__items">{items}</div>
      <div className="task-review__content">{content}</div>
      <div className="task-review__comments">{comments}</div>
    </section>
  );
}
