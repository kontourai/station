import {
  isProjectRoomUuid,
  PROJECT_ROOM_LIMITS,
} from '@kontourai/station-contracts/project-room';
import {
  type ApiRequestScope,
  isProjectRoomAccessError,
  type ProjectRoomAgentHandle,
  type ProjectRoomAgentIntent,
  type ProjectRoomMessageIntent,
  ProjectRoomProtocolError,
  parseProjectRoomAgentIntent,
  parseProjectRoomMessageIntent,
  useProjectRoom,
  useProjectRoomAgent,
} from '@kontourai/station-sdk/project-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { LazyMarkdown } from '../../components/chat/LazyMarkdown';
import { Dialog } from '../../components/Dialog';
import { Empty, SkeletonBlock } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import './ProjectRoom.css';

export interface ProjectRoomProps {
  slug: string;
  projectId: string;
  requestScope: ApiRequestScope;
  variant?: 'preview' | 'full';
  onOpenRoom?(): void;
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
        sessionStorage.removeItem(
          `station-project-room:${previous.current}:agent`,
        );
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
  storageKey,
}: ProjectRoomProps & { storageKey: string }) {
  const editorId = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
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
      sessionStorage.removeItem(`${storageKey}:agent`);
    } catch {
      /* Content is already hidden and sending stopped. */
    }
  }, [room.stopped, storageKey]);
  useEffect(() => {
    if (view && (!view.capabilities.discuss || !view.capabilities.execute)) {
      try {
        sessionStorage.removeItem(`${storageKey}:agent`);
      } catch {
        /* Agent controls are already unavailable. */
      }
    }
  }, [view, storageKey]);
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
        sessionStorage.removeItem(`${storageKey}:agent`);
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
      intentId: randomCorrelationId(),
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
        <h3># Project room</h3>
        <p>The room has not been opened yet.</p>
        {room.initialize.isError && (
          <p role="alert">
            Opening was not confirmed. Check access, then try again.
          </p>
        )}
        <Button
          pending={room.initialize.isPending}
          pendingLabel="Open room"
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
        <SkeletonBlock count={2} label="Loading room" />
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
          <h3># Project room</h3>
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
            <SkeletonBlock count={2} label="Loading conversation" />
          ) : (
            !messages.length && (
              <Empty
                variant="compact"
                label="Start a conversation with your project team."
              />
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
                {message.actor.kind === 'agent' ? (
                  <div className="project-room__answer">
                    <LazyMarkdown>{message.text}</LazyMarkdown>
                  </div>
                ) : (
                  <p className="project-room__text">{message.text}</p>
                )}
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
          {view.capabilities.discuss && view.capabilities.execute && (
            <ProjectRoomAgentPanel
              key={`${view.roomId}:${view.actor.id}`}
              requestScope={requestScope}
              slug={slug}
              projectId={projectId}
              roomId={view.roomId}
              actorId={view.actor.id}
              storageKey={`${storageKey}:agent`}
              prompt={text}
              checkpointSeq={view.checkpoint.lastSeq}
              replyTo={replyTo}
              blocked={!restored || !!proposal || room.send.isPending}
              prepareRecap={() => {
                setText(`Recap Project ${slug} (Project ID: ${projectId}; Room ID: ${view.roomId}).

Summarize this Project, its Tasks, this Room's discussion and shared notes, and related Project sources that current authority and available tools allow you to inspect. Cite evidence IDs and source citations for factual claims; distinguish observed facts from uncertainty.

Report observed freshness and coverage, including timestamps or checkpoints when available, and unavailable, private, or partial sources and gaps. Do not claim access beyond current permissions or infer completion from missing evidence. Do not automatically promote this recap into memory or shared notes.`);
                setNotice(
                  'Recap prompt prepared. Review or edit it, then choose Bring an Agent and Ask in room.',
                );
                composer.current?.focus();
              }}
              refresh={() => {
                void room.discovery.refetch();
                void room.history.refetch();
              }}
            />
          )}
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
                ref={composer}
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
              <ActionRow
                className="project-room__actions"
                overflowLabel="More message actions"
                primary={
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
                }
                secondary={
                  proposal ? (
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
                  ) : undefined
                }
              />
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

function ProjectRoomAgentPanel({
  requestScope,
  slug,
  projectId,
  roomId,
  actorId,
  storageKey,
  prompt,
  checkpointSeq,
  replyTo,
  blocked,
  prepareRecap,
  refresh,
}: {
  requestScope: ApiRequestScope;
  slug: string;
  projectId: string;
  roomId: string;
  actorId: string;
  storageKey: string;
  prompt: string;
  checkpointSeq: number;
  replyTo?: string;
  blocked: boolean;
  prepareRecap(): void;
  refresh(): void;
}) {
  const guard = {
    expectedRoomId: roomId,
    expectedProjectId: projectId,
    expectedActorId: actorId,
  };
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [retained, setRetained] = useState<{
    intent: ProjectRoomAgentIntent;
    requestId?: string;
  }>();
  const [handle, setHandle] = useState<ProjectRoomAgentHandle>();
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [stopped, setStopped] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const [settlementVersion, setSettlementVersion] = useState(0);
  const agent = useProjectRoomAgent(requestScope, slug, guard, !stopped);
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        const intent = parseProjectRoomAgentIntent(saved.intent);
        if (
          intent.expectedRoomId === roomId &&
          intent.expectedProjectId === projectId &&
          intent.expectedActorId === actorId
        ) {
          if (
            saved.requestId !== undefined &&
            !isProjectRoomUuid(saved.requestId)
          )
            throw new Error('Invalid request');
          setRetained({
            intent,
            ...(saved.requestId ? { requestId: saved.requestId } : {}),
          });
          setNotice(
            'Previous Agent request retained. Inspect it or retry the exact request.',
          );
        } else sessionStorage.removeItem(storageKey);
      }
      setReady(true);
    } catch {
      setNotice('Agent request storage unavailable.');
    }
    return () => {
      mounted.current = false;
    };
  }, [storageKey, roomId, projectId, actorId]);
  const available =
    agent.catalog.isSuccess &&
    agent.catalog.data?.catalogState !== 'reconciling'
      ? (agent.catalog.data?.agents.filter((a) => a.available !== false) ?? [])
      : [];
  async function act(action: 'request' | 'inspect' | 'reconcile' | 'cancel') {
    if (!ready || stopped || busy.current) return;
    let saved = retained;
    if (!saved) {
      if (
        action !== 'request' ||
        blocked ||
        !available.some((a) => a.slug === agentId)
      )
        return;
      saved = {
        intent: parseProjectRoomAgentIntent({
          ...guard,
          intentId: randomCorrelationId(),
          agentId,
          text: prompt,
          ...(replyTo ? { replyTo } : {}),
        }),
      };
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
      setRetained(saved);
    } catch {
      setNotice('Enable session storage before requesting an Agent.');
      return;
    }
    busy.current = true;
    setOpen(false);
    try {
      const result = await agent.request.mutateAsync(
        action === 'request'
          ? saved.intent
          : { requestId: saved.requestId!, action },
      );
      if (!mounted.current) return;
      if (
        result.intentId !== saved.intent.intentId ||
        result.agentId !== saved.intent.agentId ||
        result.text !== saved.intent.text ||
        result.replyTo !== saved.intent.replyTo ||
        result.actor.id !== actorId
      )
        throw new ProjectRoomProtocolError('Agent request changed.');
      setHandle(result);
      const next = { intent: saved.intent, requestId: result.requestId };
      setRetained(next);
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setOpen(false);
      setNotice('');
      if (result.state === 'published') refresh();
    } catch (error) {
      if (!mounted.current) return;
      if (
        isProjectRoomAccessError(error) ||
        error instanceof ProjectRoomProtocolError
      ) {
        setStopped(true);
        setRetained(undefined);
        setHandle(undefined);
        sessionStorage.removeItem(storageKey);
        setNotice('Agent request access changed. Check Room access.');
      } else
        setNotice(
          'Agent request not confirmed. Retry the same request or inspect its handle.',
        );
    } finally {
      busy.current = false;
      if (mounted.current) setSettlementVersion((version) => version + 1);
    }
  }
  const terminal =
    handle?.state === 'published' || handle?.state === 'cancelled';
  const inspectedCheckpoint = useRef('');
  const requestAction = useRef(act);
  useLayoutEffect(() => {
    requestAction.current = act;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: settlement wakes the latest checkpoint skipped while the request ref was busy.
  useEffect(() => {
    if (!retained?.requestId || stopped || terminal || busy.current) return;
    const key = `${retained.requestId}:${checkpointSeq}`;
    if (inspectedCheckpoint.current === key) return;
    inspectedCheckpoint.current = key;
    void requestAction.current('inspect');
  }, [
    retained?.requestId,
    checkpointSeq,
    stopped,
    terminal,
    settlementVersion,
  ]);

  return (
    <div className="project-room__agent">
      {notice && <p role="status">{notice}</p>}
      {handle && (
        <p role="status">
          {handle.failure
            ? `Agent request needs attention: ${handle.failure.replaceAll('_', ' ')}`
            : {
                reserved: 'Agent request accepted.',
                started:
                  'Agent is working. Its answer will appear in the Room.',
                published: 'Agent answer shared in the Room.',
                uncertain:
                  'Agent start could not be confirmed. Check its answer before retrying.',
                cancelled: 'Agent request cancelled.',
              }[handle.state]}
        </p>
      )}
      {retained ? (
        <ActionRow
          overflowLabel="More Agent actions"
          primary={
            terminal ? (
              <Button
                onClick={() => {
                  sessionStorage.removeItem(storageKey);
                  setRetained(undefined);
                  setHandle(undefined);
                  setNotice('');
                }}
              >
                New Agent request
              </Button>
            ) : retained.requestId ? (
              <Button
                pending={agent.request.isPending}
                disabled={stopped}
                onClick={() => void act('reconcile')}
              >
                Check answer
              </Button>
            ) : (
              <Button
                pending={agent.request.isPending}
                disabled={stopped}
                onClick={() => void act('request')}
              >
                Retry same Agent request
              </Button>
            )
          }
          secondary={
            retained.requestId && !terminal ? (
              <Button
                disabled={agent.request.isPending || stopped}
                onClick={() => void act('inspect')}
              >
                Inspect request
              </Button>
            ) : undefined
          }
          overflow={
            retained.requestId && !terminal
              ? [
                  {
                    key: 'cancel',
                    label: 'Cancel Agent request',
                    disabled: agent.request.isPending || stopped,
                    onSelect: () => {
                      void act('cancel');
                    },
                  },
                ]
              : []
          }
        />
      ) : (
        <div className="project-room__actions">
          <Button
            size="sm"
            disabled={blocked || !ready || stopped || !!prompt || !!replyTo}
            title={
              prompt || replyTo
                ? 'Keep or clear your current draft and reply before preparing a recap.'
                : 'Prepare a recap prompt to review before asking an Agent.'
            }
            onClick={() => {
              if (blocked || !ready || stopped || retained || prompt || replyTo)
                return;
              prepareRecap();
            }}
          >
            Recap Project
          </Button>
          <Button
            disabled={
              blocked ||
              !ready ||
              stopped ||
              !prompt.trim() ||
              new TextEncoder().encode(prompt).length >
                PROJECT_ROOM_LIMITS.textBytes
            }
            onClick={() => setOpen(true)}
          >
            Bring an Agent
          </Button>
        </div>
      )}
      {open && (
        <Dialog
          title="Bring an Agent"
          closeLabel="Close Agent selection"
          onClose={() => setOpen(false)}
          footer={
            <Button
              variant="primary"
              pending={agent.request.isPending}
              disabled={
                !available.some((a) => a.slug === agentId) ||
                blocked ||
                stopped ||
                !prompt.trim() ||
                new TextEncoder().encode(prompt).length >
                  PROJECT_ROOM_LIMITS.textBytes
              }
              onClick={() => void act('request')}
            >
              Ask in room
            </Button>
          }
        >
          {agent.catalog.isPending ? (
            <SkeletonBlock label="Loading Agents" />
          ) : agent.catalog.isError ? (
            <p role="alert">
              Agents unavailable.{' '}
              <Button onClick={() => void agent.catalog.refetch()}>
                Try again
              </Button>
            </p>
          ) : agent.catalog.data?.catalogState === 'reconciling' ? (
            <p role="status">
              Agents are updating.{' '}
              <Button onClick={() => void agent.catalog.refetch()}>
                Refresh Agents
              </Button>
            </p>
          ) : !available.length ? (
            <Empty label="Agents unavailable" />
          ) : (
            <label>
              Agent
              <select
                className="project-room__agent-select"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="">Choose an Agent</option>
                {available.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="project-room__text">
            {retained?.intent.text ?? prompt}
          </p>
        </Dialog>
      )}
    </div>
  );
}
