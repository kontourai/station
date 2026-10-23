import { PROJECT_ROOM_LIMITS } from '@kontourai/station-contracts/project-room';
import {
  type ApiRequestScope,
  type ProjectRoomMessageIntent,
  parseProjectRoomMessageIntent,
  useProjectRoom,
} from '@kontourai/station-sdk/project-rooms';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import './ProjectRoom.css';

export interface ProjectRoomProps {
  slug: string;
  projectId: string;
  requestScope: ApiRequestScope;
  variant?: 'preview' | 'full';
  onOpenRoom?(): void;
  onRequestAgent?(input: {
    prompt: string;
    replyTo?: string;
  }): void | Promise<void>;
}
function scopeKey(props: ProjectRoomProps) {
  return JSON.stringify([
    props.requestScope.apiBase,
    props.requestScope.authorityKey,
    props.projectId,
    props.slug,
  ]);
}
export function ProjectRoom(props: ProjectRoomProps) {
  const key = scopeKey(props);
  const previous = useRef(key);
  useLayoutEffect(() => {
    if (previous.current !== key) {
      // Authority switches retire the prior browser's retained proposal.
      try {
        sessionStorage.removeItem(`station-project-room:${previous.current}`);
      } catch {
        /* Sending requires successful storage separately. */
      }
      previous.current = key;
    }
  }, [key]);
  return (
    <ProjectRoomSession
      key={key}
      {...props}
      storageKey={`station-project-room:${key}`}
    />
  );
}
function ProjectRoomSession({
  slug,
  projectId,
  requestScope,
  variant = 'full',
  onOpenRoom,
  onRequestAgent,
  storageKey,
}: ProjectRoomProps & { storageKey: string }) {
  const editorId = useId();
  const room = useProjectRoom(requestScope, slug, projectId);
  const view = room.discovery.data;
  const [tab, setTab] = useState<'conversation' | 'notes'>('conversation');
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<string>();
  const [proposal, setProposal] = useState<ProjectRoomMessageIntent>();
  const [restored, setRestored] = useState(false);
  const [notice, setNotice] = useState('');
  const [noteDraft, setNoteDraft] = useState<{
    markdown: string;
    revision: number;
    sourceMessageIds: string[];
  }>();
  const [agentPending, setAgentPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const clearProposal = () => {
    sessionStorage.removeItem(storageKey);
    setProposal(undefined);
  };
  const { guard, DiscardModal } = useUnsavedGuard(
    !!text || !!proposal || !!noteDraft,
    () => {
      try {
        clearProposal();
      } catch {
        return false;
      }
      setText('');
      setReplyTo(undefined);
      setNoteDraft(undefined);
      return true;
    },
  );
  useEffect(() => {
    if (!view || restored) return;
    setRestored(true);
    try {
      const retained = sessionStorage.getItem(storageKey);
      if (!retained) return;
      const input = parseProjectRoomMessageIntent(JSON.parse(retained));
      if (
        input.expectedProjectId !== projectId ||
        input.expectedRoomId !== view.roomId ||
        input.expectedActorId !== view.actor.id
      ) {
        sessionStorage.removeItem(storageKey);
        return;
      }
      setProposal(input);
      setText(input.text);
      setReplyTo(input.replyTo);
      setNotice(
        'A previous send has no confirmed acknowledgement. Check the conversation, then retry the same message if needed.',
      );
    } catch {
      setNotice('The retained message could not be recovered.');
    }
  }, [view, restored, storageKey, projectId]);
  useEffect(() => {
    if (!room.stopped) return;
    setText('');
    setReplyTo(undefined);
    setProposal(undefined);
    setNoteDraft(undefined);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Content is already hidden and sending stopped. */
    }
  }, [room.stopped, storageKey]);
  const actorId = view?.actor.id;
  const discoveredActor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!actorId) return;
    if (discoveredActor.current && discoveredActor.current !== actorId) {
      setText('');
      setReplyTo(undefined);
      setProposal(undefined);
      setNoteDraft(undefined);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Sending still requires storage. */
      }
      setNotice('The person using this room changed. Start a new message.');
    }
    discoveredActor.current = actorId;
  }, [actorId, storageKey]);
  async function send() {
    if (!view || room.stopped || !restored || room.send.isPending) return;
    const input = proposal ?? {
      expectedRoomId: view.roomId,
      expectedProjectId: projectId,
      expectedActorId: view.actor.id,
      intentId: crypto.randomUUID(),
      text,
      ...(replyTo ? { replyTo } : {}),
    };
    try {
      // Persist the exact immutable payload before the network can commit it.
      sessionStorage.setItem(storageKey, JSON.stringify(input));
      setProposal(input);
    } catch {
      setNotice(
        'This browser cannot retain the message safely. Enable session storage before sending.',
      );
      return;
    }
    try {
      await room.send.mutateAsync(input);
      if (!mounted.current) return;
      clearProposal();
      setText('');
      setReplyTo(undefined);
      setNotice('');
    } catch {
      if (mounted.current)
        setNotice(
          'Send not confirmed. Check the conversation before retrying this exact message.',
        );
    }
  }
  async function saveNote() {
    if (!view || !noteDraft) return;
    try {
      await room.note.mutateAsync({
        expectedRoomId: view.roomId,
        expectedProjectId: projectId,
        expectedActorId: view.actor.id,
        expectedRevision: noteDraft.revision,
        markdown: noteDraft.markdown,
        sourceMessageIds: noteDraft.sourceMessageIds,
      });
      if (mounted.current) {
        setNoteDraft(undefined);
        setNotice('Notes saved.');
      }
    } catch {
      if (!mounted.current) return;
      setNotice(
        'Notes were not saved. Reload the current notes and compare your draft before saving again.',
      );
      void room.discovery.refetch();
    }
  }
  if (room.stopped)
    return (
      <section className="project-room" aria-label="Project room">
        <p role="status">
          Room access changed. Your draft was cleared. Check access to continue.
        </p>
        <Button onClick={room.recover}>Check access</Button>
      </section>
    );
  if (room.unprovisioned)
    return (
      <section className="project-room" aria-label="Project room">
        <h2># Project room</h2>
        <p>The room has not been opened yet.</p>
        {room.initialize.isError && (
          <p role="alert">
            Opening was not confirmed. Check access, then try again.
          </p>
        )}
        <Button
          pending={room.initialize.isPending}
          pendingLabel="Opening…"
          onClick={() => room.initialize.mutate()}
        >
          Open room
        </Button>
      </section>
    );
  if (room.discovery.isError)
    return (
      <section className="project-room" aria-label="Project room">
        <p role="alert">
          Room unavailable. Check your connection and Project access, then try
          again.
        </p>
        <Button onClick={room.recover}>Try again</Button>
      </section>
    );
  if (!view)
    return (
      <section className="project-room" aria-label="Project room">
        <p role="status">Loading room…</p>
      </section>
    );
  const messages = [
    ...new Map(
      (room.history.data?.pages.flatMap((page) => page.messages) ?? []).map(
        (message) => [message.messageId, message],
      ),
    ).values(),
  ].sort((a, b) => a.seq - b.seq);
  const visibleMessages = variant === 'preview' ? messages.slice(-5) : messages;
  const participants = [
    ...new Map(
      view.presence
        .filter((p) => Date.parse(p.expiresAt) > Date.now())
        .map((p) => [p.actor.id, p.actor]),
    ).values(),
  ];
  const noteText = noteDraft?.markdown ?? view.note?.markdown ?? '';
  const selectedReply = messages.find(
    (message) => message.messageId === replyTo,
  );
  return (
    <section
      className={`project-room project-room--${variant}`}
      aria-label="Project room"
    >
      <header className="project-room__header">
        <div className="project-room__title">
          <h2># Project room</h2>
          <details className="project-room__menu">
            <summary aria-label="Room menu">Room ▾</summary>
            <Button onClick={() => guard(() => setTab('conversation'))}>
              Conversation
            </Button>
            <Button onClick={() => guard(() => setTab('notes'))}>
              Shared notes
            </Button>
          </details>
        </div>
        {variant === 'preview' && onOpenRoom && (
          <Button onClick={onOpenRoom}>Open room</Button>
        )}
      </header>
      <div
        className="project-room__presence"
        role="status"
        aria-label="People here"
      >
        {participants.length
          ? participants.map((actor) => actor.displayName).join(', ')
          : 'No one else is here right now.'}
      </div>
      <nav className="project-room__tabs" aria-label="Room views">
        <Button
          active={tab === 'conversation'}
          aria-pressed={tab === 'conversation'}
          onClick={() => guard(() => setTab('conversation'))}
        >
          Conversation
        </Button>
        <Button
          active={tab === 'notes'}
          aria-pressed={tab === 'notes'}
          onClick={() => guard(() => setTab('notes'))}
        >
          Notes
        </Button>
      </nav>
      {room.streamError && (
        <p role="status">
          Live updates are interrupted.{' '}
          <Button
            onClick={() => {
              void room.discovery.refetch();
              void room.history.refetch();
            }}
          >
            Refresh conversation
          </Button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === 'conversation' ? (
        <>
          {variant === 'full' && room.history.hasNextPage && (
            <Button
              pending={room.history.isFetchingNextPage}
              onClick={() => {
                void room.history.fetchNextPage();
              }}
            >
              Load older messages
            </Button>
          )}
          {room.history.isError ? (
            <p role="alert">
              Conversation history could not be loaded.{' '}
              <Button
                onClick={() => {
                  void room.history.refetch();
                }}
              >
                Try again
              </Button>
            </p>
          ) : room.history.isPending ? (
            <p role="status">Loading conversation…</p>
          ) : (
            !messages.length && (
              <p className="project-room__empty">
                Start a conversation with your project team.
              </p>
            )
          )}
          <ol className="project-room__messages" aria-label="Conversation">
            {visibleMessages.map((message) => (
              <li key={message.messageId} className="project-room__message">
                <div className="project-room__byline">
                  <strong>{message.actor.displayName}</strong>
                  {message.actor.kind === 'agent' && <span>Agent</span>}
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                </div>
                {message.replyTo && (
                  <p className="project-room__reply">
                    Reply to{' '}
                    {messages.find((m) => m.messageId === message.replyTo)
                      ?.actor.displayName ?? 'an earlier message'}
                  </p>
                )}
                <p className="project-room__text">{message.text}</p>
                {view.capabilities.discuss && (
                  <Button
                    variant="ghost"
                    disabled={!!proposal || room.send.isPending}
                    aria-label={`Reply to ${message.actor.displayName}`}
                    onClick={() => setReplyTo(message.messageId)}
                  >
                    Reply
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {view.capabilities.discuss ? (
            <form
              className="project-room__composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {replyTo && (
                <div>
                  Replying to{' '}
                  {selectedReply?.actor.displayName ?? 'an earlier message'}{' '}
                  <Button
                    type="button"
                    disabled={!!proposal}
                    onClick={() => setReplyTo(undefined)}
                  >
                    Cancel reply
                  </Button>
                </div>
              )}
              <label htmlFor={`message-${editorId}`}>Message the project</label>
              <textarea
                id={`message-${editorId}`}
                value={text}
                readOnly={!!proposal || room.send.isPending}
                onChange={(event) => setText(event.target.value)}
                placeholder="Share an update or ask the team…"
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === 'Enter'
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="project-room__actions">
                <Button
                  type="submit"
                  variant="primary"
                  pending={room.send.isPending}
                  pendingLabel="Sending…"
                  disabled={
                    !restored ||
                    !text.trim() ||
                    new TextEncoder().encode(text).length >
                      PROJECT_ROOM_LIMITS.textBytes
                  }
                >
                  {proposal ? 'Retry same message' : 'Send message'}
                </Button>
                {proposal && (
                  <Button
                    type="button"
                    onClick={() =>
                      guard(() => {
                        clearProposal();
                        setText('');
                        setReplyTo(undefined);
                        setNotice('');
                      })
                    }
                  >
                    Discard retained message
                  </Button>
                )}
                {onRequestAgent && view.capabilities.execute && (
                  <Button
                    type="button"
                    pending={agentPending}
                    disabled={!!proposal || !text.trim()}
                    onClick={async () => {
                      setAgentPending(true);
                      try {
                        await onRequestAgent({
                          prompt: text,
                          ...(replyTo ? { replyTo } : {}),
                        });
                        if (mounted.current) {
                          setText('');
                          setReplyTo(undefined);
                        }
                      } catch {
                        if (mounted.current)
                          setNotice(
                            'The Agent request was not confirmed. Check the room before trying again.',
                          );
                      } finally {
                        if (mounted.current) setAgentPending(false);
                      }
                    }}
                  >
                    Bring an Agent
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <p>You can read this conversation.</p>
          )}
        </>
      ) : (
        <div className="project-room__notes">
          <h3>Shared notes</h3>

          <label htmlFor={`note-${editorId}`}>Notes (Markdown)</label>
          <textarea
            id={`note-${editorId}`}
            value={noteText}
            readOnly={!view.capabilities.edit || room.note.isPending}
            onChange={(event) =>
              setNoteDraft((current) => ({
                markdown: event.target.value,
                revision: current?.revision ?? view.note?.revision ?? 0,
                sourceMessageIds:
                  current?.sourceMessageIds ??
                  view.note?.sourceMessageIds ??
                  [],
              }))
            }
          />
          {view.note && (
            <p>
              Updated by {view.note.actor.displayName} ·{' '}
              <time dateTime={view.note.updatedAt}>
                {new Date(view.note.updatedAt).toLocaleString()}
              </time>
            </p>
          )}
          {noteDraft &&
            view.note &&
            noteDraft.revision !== view.note.revision && (
              <div role="alert">
                <p>
                  Shared notes changed while you were editing. Your draft is
                  preserved above.
                </p>
                <details>
                  <summary>Current shared notes</summary>
                  <pre>{view.note.markdown}</pre>
                </details>
                <Button
                  onClick={() =>
                    setNoteDraft((current) =>
                      current
                        ? { ...current, revision: view.note!.revision }
                        : current,
                    )
                  }
                >
                  Use my draft over this version
                </Button>
              </div>
            )}
          <div className="project-room__actions">
            {view.capabilities.edit && (
              <Button
                pending={room.note.isPending}
                disabled={
                  !noteDraft ||
                  new TextEncoder().encode(noteText).length >
                    PROJECT_ROOM_LIMITS.noteBytes ||
                  (!!view.note && noteDraft.revision !== view.note.revision)
                }
                onClick={() => {
                  void saveNote();
                }}
              >
                Save notes
              </Button>
            )}
            {noteDraft && (
              <Button onClick={() => guard(() => setNoteDraft(undefined))}>
                Discard note draft
              </Button>
            )}
          </div>
        </div>
      )}
      <DiscardModal />
    </section>
  );
}
