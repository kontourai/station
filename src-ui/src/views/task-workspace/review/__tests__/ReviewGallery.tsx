import type {
  TaskReviewAnchor,
  TaskReviewFilter,
  TaskReviewItem,
} from '@kontourai/station-contracts/task-review';
import { useState } from 'react';
import { ReviewCommentsRail } from '../ReviewCommentsRail';
import { ReviewDocumentView } from '../ReviewDocumentView';
import { ReviewImageView } from '../ReviewImageView';
import { ReviewItemList } from '../ReviewItemList';
import { TaskReviewLayout } from '../TaskReviewLayout';
import {
  captureThread,
  currentArtifact,
  items,
  plan,
  screenSrc,
  text,
  threads,
} from './review-fixtures';

export function ReviewGallery() {
  const [selected, setSelected] = useState<TaskReviewItem>(items[0]);
  const [filter, setFilter] = useState<TaskReviewFilter>('open');
  const [ids, setIds] = useState<readonly string[]>(['open-1', 'open-2']);
  const [lastAction, setLastAction] = useState('');
  const create = (anchor: TaskReviewAnchor, body: string) =>
    setLastAction(JSON.stringify({ anchor, body }));
  return (
    <>
      <TaskReviewLayout
        items={
          <ReviewItemList
            items={items}
            selectedItemId={selected.id}
            selectedKind={selected.kind}
            onSelectItem={setSelected}
            captureSrc={() => screenSrc}
          />
        }
        content={
          selected.kind === 'capture' ? (
            <ReviewImageView
              src={screenSrc}
              alt="October export replay"
              threads={[captureThread]}
              onSelectThread={setLastAction}
              onCreateThread={create}
            />
          ) : (
            <ReviewDocumentView
              artifact={
                selected.status === 'available' ? selected.artifact : plan
              }
              text={
                selected.status === 'available' ? (selected.text ?? text) : text
              }
              title={selected.label}
              threads={threads}
              onCreateThread={create}
            />
          )
        }
        comments={
          <ReviewCommentsRail
            threads={threads}
            currentArtifact={currentArtifact}
            filter={filter}
            onFilterChange={setFilter}
            selectedThreadIds={ids}
            onSelectionChange={setIds}
            onSend={(threadIds) => setLastAction(threadIds.join(','))}
            resolveAuthor={(author) =>
              author.kind === 'session'
                ? { name: 'Claude Code', startedBy: { name: 'Brian' } }
                : { name: 'Brian' }
            }
            onReply={(id, body) => setLastAction(`${id}: ${body}`)}
            onResolve={setLastAction}
            onReopen={setLastAction}
            captureSrc={() => screenSrc}
            onOpenCapture={() => setSelected(items[2])}
          />
        }
      />
      <output className="review-sr-only" aria-label="Last review action">
        {lastAction}
      </output>
    </>
  );
}
