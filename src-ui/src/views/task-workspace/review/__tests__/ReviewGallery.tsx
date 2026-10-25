import type {
  TaskReviewAnchor,
  TaskReviewItem,
} from '@kontourai/station-contracts/task-review';
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
  threads,
} from './review-fixtures';

export function ReviewGallery() {
  const [selected, setSelected] = useState<TaskReviewItem>(items[0]);
  const artifactKey = `${selected.kind}:${selected.id}`;
  const [ids, setIds] = useState<readonly string[]>(['open-1', 'open-2']);
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
            captureSrc={() => screenSrc}
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
              title={selected.label}
              key={artifactKey}
              threads={threads}
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
                  ? threads
                  : []
            }
            counts={selected.counts}
            artifactKey={artifactKey}
            selectedThreadIds={ids}
            onSelectionChange={setIds}
            onSend={(threadIds, mode) =>
              setLastAction(`${mode}:${threadIds.join(',')}`)
            }
            delivery={{ agentName: 'Claude Code', working: true }}
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
