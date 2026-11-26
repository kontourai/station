import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { InboxTaskRow } from '../components/chat-dock/ChatDockInboxRows';
import { useSwipeActions } from '../hooks/useSwipeActions';
import {
  type HomeWorkItem,
  TASK_AWAITS_ANSWER_LABEL,
} from '../views/home/home-view-model';
import '../index.css';
import '../tailwind.css';
import './inbox-storyboard.css';

const now = Date.parse('2026-11-26T18:00:00Z');
const examples = [
  {
    id: 'qualification',
    project: 'Station',
    title: 'Review the nightly qualification plan',
    reason: 'Should this week’s qualification use the new runner?',
    action: 'Reply',
  },
  {
    id: 'review',
    project: 'Station',
    title: 'Review the pull requests panel',
    reason: 'An independent review is waiting for approval.',
    action: 'Review',
  },
  {
    id: 'release',
    project: 'Station Site',
    title: 'Verify release claims',
    reason: 'The release check could not fetch the published tag.',
    action: 'Retry',
  },
] as const;

type Example = (typeof examples)[number];
type Action = Example['action'] | 'Mark reviewed' | 'Snooze';

function task(example: Example): HomeWorkItem {
  return {
    id: example.id,
    kind: 'task',
    kindLabel: (
      {
        Reply: TASK_AWAITS_ANSWER_LABEL,
        Review: 'Task · In review',
        Retry: 'Task · Blocked',
      } as const
    )[example.action],
    title: example.title,
    projectLabel: example.project,
    agentLabel: 'Codex',
    modelLabel: '',
    lifecycleLabel: 'Needs attention',
    updatedAt: now - 120_000,
  };
}

function StoryRow({
  example,
  proposed,
  phone,
  onAction,
}: {
  example: Example;
  proposed: boolean;
  phone: boolean;
  onAction: (example: Example, action: Action) => void;
}) {
  const swipe = useSwipeActions(phone && proposed, {
    actionWidth: 175,
    triggerSelector: '.inbox-row__open',
  });
  const secondary =
    example.action === 'Retry' ? 'Mark reviewed' : example.action;
  const failed = example.action === 'Retry';
  const snooze = () => onAction(example, 'Snooze');
  const actions = (
    <ActionRow
      primary={
        <Button
          variant="primary"
          onClick={() => onAction(example, example.action)}
        >
          {example.action}
        </Button>
      }
      secondary={
        <Button
          variant="ghost"
          onClick={() =>
            failed ? onAction(example, 'Mark reviewed') : snooze()
          }
        >
          {failed ? 'Mark reviewed' : 'Snooze'}
        </Button>
      }
      overflow={
        failed ? [{ key: 'snooze', label: 'Snooze', onSelect: snooze }] : []
      }
      overflowLabel={`More actions for ${example.title}`}
    />
  );

  return (
    <div
      ref={swipe.ref}
      className={phone && proposed ? 'storyboard-swipe' : undefined}
      style={swipe.style}
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
      onLostPointerCapture={swipe.onLostPointerCapture}
      onClickCapture={swipe.onClickCapture}
    >
      {phone && proposed && (
        <div
          className="storyboard-tray"
          hidden={!swipe.open}
          inert={!swipe.open}
        >
          <Button variant="ghost" onClick={() => onAction(example, 'Snooze')}>
            Snooze
          </Button>
          <Button variant="ghost" onClick={() => onAction(example, secondary)}>
            {secondary}
          </Button>
        </div>
      )}
      <div className="storyboard-swipe-content">
        <InboxTaskRow
          item={task(example)}
          isSnoozed={false}
          now={now}
          chrome={phone ? 'touch' : 'hover'}
          onActivate={() => onAction(example, example.action)}
          attention={proposed ? { reason: example.reason, actions } : undefined}
        />
      </div>
    </div>
  );
}

function InboxStory({
  proposed,
  phone,
}: {
  proposed: boolean;
  phone: boolean;
}) {
  const [handled, setHandled] = useState<
    Partial<Record<Example['id'], Action>>
  >({});
  const [pending, setPending] = useState<{
    example: Example;
    action: Action;
  }>();
  const [undo, setUndo] = useState<Example['id']>();
  const visible = examples.filter((example) => !handled[example.id]);

  function act(example: Example, action: Action) {
    if (action === 'Reply' || action === 'Review' || action === 'Snooze') {
      setPending({ example, action });
      return;
    }
    apply(example, action);
  }

  function apply(example: Example, action: Action) {
    setHandled((previous) => ({ ...previous, [example.id]: action }));
    setUndo(
      action === 'Snooze' || action === 'Mark reviewed'
        ? example.id
        : undefined,
    );
    setPending(undefined);
  }

  return (
    <section className={phone ? 'storyboard-phone' : undefined}>
      <h2>{proposed ? 'Proposed inbox' : 'Current inbox'}</h2>
      <div className="chat-dock-inbox storyboard-inbox">
        <div className="chat-dock-inbox__scroll">
          <h3>Needs attention · {visible.length}</h3>
          {visible.map((example) => (
            <StoryRow
              key={example.id}
              example={example}
              proposed={proposed}
              phone={phone}
              onAction={act}
            />
          ))}
          {undo && (
            <div className="storyboard-feedback" role="status">
              {handled[undo] === 'Snooze'
                ? 'Snoozed until tomorrow at 9 AM'
                : 'Marked reviewed'}
              <Button
                variant="ghost"
                onClick={() => {
                  setHandled(({ [undo]: _action, ...remaining }) => remaining);
                  setUndo(undefined);
                }}
              >
                Undo
              </Button>
            </div>
          )}
          {Object.values(handled).includes('Snooze') && (
            <h3>
              Snoozed ·{' '}
              {
                Object.values(handled).filter((action) => action === 'Snooze')
                  .length
              }
            </h3>
          )}
        </div>
      </div>
      {pending && (
        <form
          className="storyboard-request"
          onSubmit={(event) => {
            event.preventDefault();
            apply(pending.example, pending.action);
          }}
        >
          <strong>{pending.example.title}</strong>
          <p>
            {pending.action === 'Snooze'
              ? 'Snooze until tomorrow at 9 AM.'
              : pending.example.reason}
          </p>
          {pending.action === 'Reply' && (
            <textarea required aria-label="Your reply" />
          )}
          <div className="storyboard-toolbar">
            <Button type="submit" variant="primary">
              {pending.action === 'Reply'
                ? 'Send reply'
                : pending.action === 'Review'
                  ? 'Approve'
                  : 'Snooze'}
            </Button>
            <Button variant="ghost" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function InboxStoryboard() {
  const [phone, setPhone] = useState(false);
  const [light, setLight] = useState(false);
  return (
    <main className="inbox-storyboard">
      <h1>Inbox storyboard</h1>
      <div className="storyboard-toolbar">
        <Button
          variant="ghost"
          aria-pressed={phone}
          onClick={() => setPhone(!phone)}
        >
          Phone width
        </Button>
        <Button
          variant="ghost"
          aria-pressed={light}
          onClick={() => {
            document.documentElement.dataset.theme = light ? 'dark' : 'light';
            setLight(!light);
          }}
        >
          Light theme
        </Button>
      </div>
      <div className="storyboard-comparison">
        <InboxStory proposed={false} phone={phone} />
        <InboxStory proposed phone={phone} />
      </div>
    </main>
  );
}

const root = document.getElementById('root');
if (import.meta.env.DEV && root) createRoot(root).render(<InboxStoryboard />);
