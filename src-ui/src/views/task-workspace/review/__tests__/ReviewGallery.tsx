import type {
  TaskReviewAnchor,
  TaskReviewItem,
} from '@kontourai/station-contracts/task-review';
import '../../../TaskWorkspaceView.css';
import { useState } from 'react';
import { ReviewCommentsRail } from '../ReviewCommentsRail';
import { ReviewDocumentView } from '../ReviewDocumentView';
import { ReviewImageView } from '../ReviewImageView';
import { ReviewItemList } from '../ReviewItemList';
import { TaskReviewLayout } from '../TaskReviewLayout';
import {
  capture,
  captureArtifact,
  captureThread,
  items,
  plan,
  screenSrc,
  text,
  thread,
  threads,
} from './review-fixtures';

export function ReviewGallery({
  failedSend = false,
  deliveryState = 'queued',
}: {
  failedSend?: boolean;
  deliveryState?: 'queued' | 'sent' | 'unconfirmed';
}) {
  const reviewThreads = failedSend
    ? threads.map((value) =>
        value.threadId === 'open-2'
          ? thread('open-2', 2, ['comment', 'sent', 'send-failed'])
          : value,
      )
    : threads.map((value) =>
        value.threadId === 'sent'
          ? {
              ...value,
              deliveryStatus:
                deliveryState === 'unconfirmed'
                  ? ('unconfirmed' as const)
                  : ('confirmed' as const),
            }
          : value,
      );
  const [selected, setSelected] = useState<TaskReviewItem>(items[0]);
  const artifactKey = `${selected.kind}:${selected.id}`;
  const [lastAction, setLastAction] = useState('');
  const create = (anchor: TaskReviewAnchor, body: string, quote?: string) =>
    setLastAction(JSON.stringify({ anchor, body, quote }));
  return (
    <>
      <TaskReviewLayout
        items={
          <ReviewItemList
            items={items}
            selectedItemId={selected.id}
            selectedKind={selected.kind}
            onSelectItem={setSelected}
          />
        }
        content={
          selected.kind === 'capture' ? (
            <ReviewImageView
              draftScope="station-1:account-1:task-1:2026-10-25"
              artifact={captureArtifact}
              capture={capture}
              src={screenSrc}
              alt="October export replay"
              threads={[captureThread]}
              onSelectThread={setLastAction}
              onCreateThread={create}
            />
          ) : (
            <ReviewDocumentView
              draftScope="station-1:account-1:task-1:2026-10-25"
              artifact={
                selected.status === 'available' ? selected.artifact : plan
              }
              text={
                selected.status === 'available' ? (selected.text ?? text) : text
              }
              previousArtifact={selected.kind === 'plan' ? plan : undefined}
              title={selected.label}
              key={artifactKey}
              threads={reviewThreads}
              onCreateThread={create}
            />
          )
        }
        comments={
          <ReviewCommentsRail
            draftScope="station-1:account-1"
            threads={
              selected.kind === 'capture'
                ? [captureThread]
                : selected.kind === 'plan'
                  ? reviewThreads
                  : []
            }
            counts={selected.counts}
            artifactKey={artifactKey}
            onSend={(threadIds, mode) =>
              setLastAction(`${mode}:${threadIds.join(',')}`)
            }
            delivery={{
              agentName: 'Claude Code',
              working: deliveryState === 'queued',
            }}
            onOpenEvidence={(evidence) =>
              setLastAction(JSON.stringify(evidence))
            }
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
      <output className="sr-only" aria-label="Last review action">
        {lastAction}
      </output>
    </>
  );
}
