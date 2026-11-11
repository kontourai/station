import {
  isProjectRoomUuid,
  PROJECT_ROOM_LIMITS,
} from '@kontourai/station-contracts/project-room';
import {
  type ApiRequestScope,
  isProjectRoomAccessError,
  type ProjectRoomAgentHandle,
  type ProjectRoomAgentIntent,
  type ProjectRoomBrowserView,
  type ProjectRoomMessageIntent,
  ProjectRoomProtocolError,
  parseProjectRoomAgentIntent,
  parseProjectRoomMessageIntent,
  useProjectRoom,
  useProjectRoomAgent,
} from '@kontourai/station-sdk/project-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { IconButton } from '../../components/IconButton';
import { ReturnGlyph } from '../../components/icons/Glyph';
import { RoomAvatar } from '../../components/room/RoomAvatar';
import { RoomComposer } from '../../components/room/RoomComposer';
import {
  RoomConversation,
  type RoomConversationRow,
} from '../../components/room/RoomConversation';
import {
  type RoomMentionCandidate,
  RoomMentionPicker,
  useRoomMention,
} from '../../components/room/RoomMentionPicker';
import {
  roomDraftKey,
  useRoomDraftValue,
} from '../../components/room/useRoomDraft';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import './ProjectRoom.css';

export interface ProjectRoomProps {
  slug: string;
  projectId: string;
  /** `draftRecoveryKey` is the shell's non-secret reload partition. */
  requestScope: ApiRequestScope & { draftRecoveryKey?: string };
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
  // Drafts follow the reload partition, not the activation epoch in `key`,
  // which changes on every reload (#4810 review 1).
  const draftKey = roomDraftKey(
    props.requestScope.draftRecoveryKey ?? props.requestScope.authorityKey,
    props.requestScope.apiBase,
    props.projectId,
    props.slug,
    'project-room',
  );
  const previous = useRef({ key, draftKey });
  useLayoutEffect(() => {
    const prior = previous.current;
    if (prior.key !== key) {
      // Authority switches retire the prior browser's retained proposal.
      try {
        sessionStorage.removeItem(`station-project-room:${prior.key}`);
        sessionStorage.removeItem(`station-project-room:${prior.key}:agent`);
        // A different partition (another credential) retires its draft too.
        if (prior.draftKey && prior.draftKey !== draftKey)
          sessionStorage.removeItem(`station-room-draft:${prior.draftKey}`);
      } catch {
        /* Sending requires successful storage separately. */
      }
    }
    previous.current = { key, draftKey };
  }, [key, draftKey]);
  return (
    <ProjectRoomSession
      key={key}
      {...props}
      storageKey={`station-project-room:${key}`}
      draftKey={draftKey}
    />
  );
}
/**
 * The full room fills the layout viewport below its own top and above the
 * dock, so its composer stays on screen. The dock's band is the shell's dock
 * slot plus the safe area (the parts of `--dock-bottom-clearance` that are not
 * the keyboard; RoomComposer lifts itself over the keyboard), read through a
 * probe because the properties are unresolved calc()s until something uses
 * them.
 */
function useFillPageHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const update = () => {
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;height:calc(var(--dock-slot-size, 0px) + var(--safe-bottom, 0px))';
      element.append(probe);
      const clearance = probe.getBoundingClientRect().height;
      probe.remove();
      // Where the room starts with every ancestor scrolled to its top.
      let top = element.getBoundingClientRect().top;
      for (let node = element.parentElement; node; node = node.parentElement)
        top += node.scrollTop;
      const below = parseFloat(
        getComputedStyle(element.closest('.project-page__layout') ?? element)
          .paddingBottom,
      );
      element.style.height = `${Math.max(
        ROOM_MIN_HEIGHT_PX,
        Math.floor(
          window.innerHeight -
            clearance -
            top -
            (Number.isFinite(below) ? below : 0),
        ),
      )}px`;
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      element.style.height = '';
    };
  }, [ref, enabled]);
}
const ROOM_MIN_HEIGHT_PX = 320;

type RoomMessage = NonNullable<
  ReturnType<typeof useProjectRoom>['history']['data']
>['pages'][number]['messages'][number];

/**
 * Messages already shown for this room. The history window is keyed by the
 * room's latest sequence, so each new message starts a fresh query; keeping
 * the rows already read stops the list from emptying and losing the reader's
 * place while the new window loads.
 */
function useRoomMessages(roomId: string | undefined, fetched: RoomMessage[]) {
  const retained = useRef<{ roomId?: string; byId: Map<string, RoomMessage> }>({
    byId: new Map(),
  });
  if (retained.current.roomId !== roomId)
    retained.current = { roomId, byId: new Map() };
  for (const message of fetched)
    retained.current.byId.set(message.messageId, message);
  return [...retained.current.byId.values()].sort((a, b) => a.seq - b.seq);
}

/** What a Project room keeps for an unsent message (#4810 review 3). */
interface ProjectRoomDraft {
  text: string;
  replyTo?: string;
  recipient?: { id: string; name: string };
}
const EMPTY_PROJECT_DRAFT: ProjectRoomDraft = { text: '' };
const PROJECT_DRAFT_CODEC = {
  encode: (draft: ProjectRoomDraft) => JSON.stringify(draft),
  decode(raw: string): ProjectRoomDraft | undefined {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const draft = value as Record<string, unknown>;
    if (typeof draft.text !== 'string') return undefined;
    const recipient = draft.recipient as Record<string, unknown> | undefined;
    return {
      text: draft.text,
      ...(typeof draft.replyTo === 'string' && isProjectRoomUuid(draft.replyTo)
        ? { replyTo: draft.replyTo }
        : {}),
      ...(recipient &&
      typeof recipient.id === 'string' &&
      typeof recipient.name === 'string' &&
      recipient.id.length > 0 &&
      recipient.id.length <= 256
        ? { recipient: { id: recipient.id, name: recipient.name } }
        : {}),
    };
  },
  isEmpty: (draft: ProjectRoomDraft) =>
    !draft.text && !draft.replyTo && !draft.recipient,
};
type Update<T> = T | ((current: T) => T);
function apply<T>(update: Update<T>, current: T): T {
  return typeof update === 'function'
    ? (update as (current: T) => T)(current)
    : update;
}

function ProjectRoomSession({
  slug,
  projectId,
  requestScope,
  variant = 'full',
  onOpenRoom,
  storageKey,
  draftKey,
}: ProjectRoomProps & { storageKey: string; draftKey: string | undefined }) {
  const editorId = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
  const section = useRef<HTMLElement>(null);
  const compact = useIsMobile();
  const room = useProjectRoom(requestScope, slug, projectId);
  const view = room.discovery.data;
  const [tab, setTab] = useState<'conversation' | 'notes'>('conversation');
  // Text, reply target and Agent recipient are restored together; the
  // recipient is revalidated against the live catalog before it is used.
  const [draft, setDraft] = useRoomDraftValue(
    draftKey,
    EMPTY_PROJECT_DRAFT,
    PROJECT_DRAFT_CODEC,
  );
  const { text, replyTo, recipient } = draft;
  const setText = useCallback(
    (update: Update<string>) =>
      setDraft((current) => ({
        ...current,
        text: apply(update, current.text),
      })),
    [setDraft],
  );
  const setReplyTo = useCallback(
    (update: Update<string | undefined>) =>
      setDraft(({ replyTo: previous, ...rest }) => {
        const next = apply(update, previous);
        return next ? { ...rest, replyTo: next } : rest;
      }),
    [setDraft],
  );
  const setRecipient = useCallback(
    (update: Update<ProjectRoomDraft['recipient']>) =>
      setDraft(({ recipient: previous, ...rest }) => {
        const next = apply(update, previous);
        return next ? { ...rest, recipient: next } : rest;
      }),
    [setDraft],
  );
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
  useFillPageHeight(section, variant === 'full' && !!view);
  const clearProposal = () => {
    sessionStorage.removeItem(storageKey);
    setProposal(undefined);
  };
  // The message draft is kept per room (`useRoomDraft`), so leaving only
  // asks about what would be lost: an unconfirmed send or a notes draft.
  const { guard, DiscardModal } = useUnsavedGuard(
    !!proposal || !!noteDraft,
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
    } catch {
      setNotice('The retained message could not be recovered.');
    }
  }, [view, restored, storageKey, projectId]);
  useEffect(() => {
    if (!room.stopped) return;
    setDraft(EMPTY_PROJECT_DRAFT);
    setProposal(undefined);
    setNoteDraft(undefined);
    try {
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(`${storageKey}:agent`);
    } catch {
      /* Content is already hidden and sending stopped. */
    }
  }, [room.stopped, storageKey, setDraft]);
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
      setDraft(EMPTY_PROJECT_DRAFT);
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
  }, [actorId, storageKey, setDraft]);
  const messages = useRoomMessages(
    room.stopped ? undefined : view?.roomId,
    room.history.data?.pages.flatMap((page) => page.messages) ?? [],
  );
  // A send whose acknowledgement was lost is settled once the room shows it.
  const committed =
    !!proposal &&
    messages.some(
      (message) =>
        message.intentId === proposal.intentId &&
        message.actor.id === proposal.expectedActorId,
    );
  useEffect(() => {
    if (!committed || room.send.isPending) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* The proposal is settled either way. */
    }
    setProposal(undefined);
  }, [committed, room.send.isPending, storageKey]);
  async function send(retry?: ProjectRoomMessageIntent) {
    if (!view || room.stopped || !restored || room.send.isPending) return;
    if (proposal && !retry) return;
    const input = retry ?? {
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
    if (!retry) {
      // The message now lives in the conversation as a pending row.
      setText('');
      setReplyTo(undefined);
    }
    setNotice('');
    try {
      await room.send.mutateAsync(input);
      if (!mounted.current) return;
      clearProposal();
    } catch {
      /* The pending row turns into "Send not confirmed" with Retry. */
    }
  }
  function discardProposal() {
    if (!proposal) return;
    const retained = proposal;
    clearProposal();
    // Nothing typed is lost: an empty composer takes the text back.
    setText((current) => current || retained.text);
    setReplyTo((current) => current ?? retained.replyTo);
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
        <h3 className="project-room__title"># Project room</h3>
        {room.initialize.isError && (
          <p role="alert">
            Opening was not confirmed. Check access, then try again.
          </p>
        )}
        <Empty
          variant="compact"
          label="The room has not been opened yet."
          action={
            <Button
              pending={room.initialize.isPending}
              pendingLabel="Open room"
              onClick={() => room.initialize.mutate()}
            >
              Open room
            </Button>
          }
        />
      </section>
    );
  if (room.discovery.isError)
    return (
      <section className="project-room" aria-label="Project room">
        <ErrorState
          variant="compact"
          title="Room unavailable. Check your connection and Project access."
          action={<Button onClick={room.recover}>Retry</Button>}
        />
      </section>
    );
  if (!view)
    return (
      <section className="project-room" aria-label="Project room">
        <SkeletonBlock count={2} label="Loading room" />
      </section>
    );
  const visibleMessages = variant === 'preview' ? messages.slice(-5) : messages;
  const participants = [
    ...new Map(
      view.presence
        .filter((p) => Date.parse(p.expiresAt) > Date.now())
        .map((p) => [p.actor.id, p.actor]),
    ).values(),
  ];
  const noteText = noteDraft?.markdown ?? view.note?.markdown ?? '';
  const authorOf = (messageId?: string) =>
    messages.find((message) => message.messageId === messageId)?.actor
      .displayName ?? 'an earlier message';
  const replyContext = (messageId: string) => (
    <span className="project-room__reply">
      <ReturnGlyph /> Replying to <strong>{authorOf(messageId)}</strong>
    </span>
  );
  const rows: RoomConversationRow[] = visibleMessages.map((message) => ({
    id: message.messageId,
    kind: 'message',
    author: {
      id: message.actor.id,
      label: message.actor.displayName,
      agent: message.actor.kind === 'agent',
    },
    at: message.createdAt,
    reply: !!message.replyTo,
    context: message.replyTo ? replyContext(message.replyTo) : undefined,
    text: message.text,
    own: message.actor.id === view.actor.id,
    actions: view.capabilities.discuss ? (
      <Button
        variant="ghost"
        size="sm"
        disabled={room.send.isPending}
        aria-label={`Reply to ${message.actor.displayName}`}
        onClick={() => {
          setReplyTo(message.messageId);
          composer.current?.focus();
        }}
      >
        <ReturnGlyph /> Reply
      </Button>
    ) : undefined,
  }));
  if (proposal && !committed)
    rows.push({
      id: `proposal:${proposal.intentId}`,
      kind: 'message',
      author: {
        id: view.actor.id,
        label: view.actor.displayName,
        agent: view.actor.kind === 'agent',
      },
      reply: !!proposal.replyTo,
      context: proposal.replyTo ? replyContext(proposal.replyTo) : undefined,
      text: proposal.text,
      own: true,
      tone: room.send.isPending ? 'pending' : 'failed',
      footer: room.send.isPending ? (
        <span className="project-room__delivery">Sending…</span>
      ) : (
        <span className="project-room__delivery project-room__delivery--failed">
          <span>Send not confirmed.</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Retry same message"
            onClick={() => void send(proposal)}
          >
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={discardProposal}>
            Discard
          </Button>
        </span>
      ),
    });
  return (
    <section
      ref={section}
      className={`project-room project-room--${variant}${compact ? ' project-room--compact' : ''}`}
      aria-label="Project room"
    >
      <header className="project-room__header">
        <h3 className="project-room__title"># Project room</h3>
        <div
          className="project-room__presence"
          role="status"
          aria-label="People here"
        >
          {participants.length ? (
            <>
              <span className="project-room__faces" aria-hidden="true">
                {participants.slice(0, 3).map((actor) => (
                  <RoomAvatar
                    key={actor.id}
                    name={actor.displayName}
                    agent={actor.kind === 'agent'}
                  />
                ))}
              </span>
              <span className="project-room__names">
                {participants.map((actor) => actor.displayName).join(', ')}
              </span>
            </>
          ) : (
            <span className="project-room__names">Just you</span>
          )}
        </div>
        <nav className="project-room__tabs" aria-label="Room views">
          <Button
            size="sm"
            active={tab === 'conversation'}
            aria-pressed={tab === 'conversation'}
            onClick={() => guard(() => setTab('conversation'))}
          >
            Conversation
          </Button>
          <Button
            size="sm"
            active={tab === 'notes'}
            aria-pressed={tab === 'notes'}
            onClick={() => guard(() => setTab('notes'))}
          >
            Notes
          </Button>
        </nav>
        {variant === 'preview' && onOpenRoom && (
          <Button size="sm" onClick={onOpenRoom}>
            Open room
          </Button>
        )}
      </header>
      {room.streamError && (
        <p role="status" className="project-room__notice">
          Live updates are interrupted.{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void room.discovery.refetch();
              void room.history.refetch();
            }}
          >
            Refresh conversation
          </Button>
        </p>
      )}
      {notice && (
        <p role="status" className="project-room__notice">
          {notice}
        </p>
      )}
      {tab === 'conversation' ? (
        <>
          <RoomConversation
            label="Conversation"
            className="project-room__conversation"
            rows={rows}
            loading={room.history.isPending}
            status={
              room.history.isError ? (
                <ErrorState
                  variant="compact"
                  title="History could not be loaded."
                  action={
                    <Button onClick={() => void room.history.refetch()}>
                      Retry
                    </Button>
                  }
                />
              ) : room.history.isPending && !messages.length ? (
                <SkeletonBlock count={2} label="Loading chat" />
              ) : undefined
            }
            empty={
              room.history.isError ? undefined : (
                <Empty
                  variant="compact"
                  label="Start a chat with your project team."
                />
              )
            }
            hasOlder={variant === 'full' && !!room.history.hasNextPage}
            loadingOlder={room.history.isFetchingNextPage}
            onLoadOlder={() => {
              void room.history.fetchNextPage();
            }}
          />
          {view.capabilities.discuss ? (
            <ProjectRoomComposer
              id={`message-${editorId}`}
              view={view}
              slug={slug}
              projectId={projectId}
              requestScope={requestScope}
              storageKey={storageKey}
              text={text}
              setText={setText}
              replyTo={replyTo}
              replyAuthor={replyTo ? authorOf(replyTo) : undefined}
              setReplyTo={setReplyTo}
              recipient={recipient}
              setRecipient={setRecipient}
              participants={participants}
              restored={restored}
              blocked={!!proposal || room.send.isPending}
              sending={room.send.isPending}
              composer={composer}
              send={() => void send()}
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
          ) : (
            <p className="project-room__notice">
              You can read this conversation.
            </p>
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

/** The Project room's adapter over the shared `RoomComposer` and `@` picker. */
function ProjectRoomComposer({
  id,
  view,
  slug,
  projectId,
  requestScope,
  storageKey,
  text,
  setText,
  replyTo,
  replyAuthor,
  setReplyTo,
  recipient,
  setRecipient,
  participants,
  restored,
  blocked,
  sending,
  composer,
  send,
  prepareRecap,
  refresh,
}: {
  id: string;
  view: ProjectRoomBrowserView;
  slug: string;
  projectId: string;
  requestScope: ApiRequestScope;
  storageKey: string;
  text: string;
  setText(value: Update<string>): void;
  replyTo?: string;
  replyAuthor?: string;
  setReplyTo(value: Update<string | undefined>): void;
  recipient?: { id: string; name: string };
  setRecipient(value: Update<ProjectRoomDraft['recipient']>): void;
  participants: ProjectRoomBrowserView['actor'][];
  restored: boolean;
  blocked: boolean;
  sending: boolean;
  composer: RefObject<HTMLTextAreaElement | null>;
  send(): void;
  prepareRecap(): void;
  refresh(): void;
}) {
  const agents = view.capabilities.execute;
  const catalog = useProjectRoomAgent(
    requestScope,
    slug,
    {
      expectedRoomId: view.roomId,
      expectedProjectId: projectId,
      expectedActorId: view.actor.id,
    },
    agents,
  ).catalog;
  const cancelReply = () => setReplyTo(undefined);
  const [recipientNotice, setRecipientNotice] = useState('');
  // A restored (or long-held) recipient must still be an available Agent the
  // reader may ask; otherwise the draft stays as a message.
  useEffect(() => {
    if (!recipient) return;
    if (!agents) {
      setRecipient(undefined);
      setRecipientNotice(
        'The saved Agent is unavailable. Your draft is kept as a message.',
      );
      return;
    }
    if (!catalog.isSuccess || catalog.data?.catalogState === 'reconciling')
      return;
    const current = catalog.data?.agents.find(
      (agent) => agent.slug === recipient.id && agent.available !== false,
    );
    if (!current) {
      setRecipient(undefined);
      setRecipientNotice(
        'The saved Agent is unavailable. Your draft is kept as a message.',
      );
    }
  }, [recipient, agents, catalog.isSuccess, catalog.data, setRecipient]);
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const agentPanel = useRef<{ ask(agentId: string): void }>(null);
  const candidates: RoomMentionCandidate[] = [
    ...participants
      .filter((actor) => actor.id !== view.actor.id && actor.kind === 'person')
      .map((actor) => ({
        id: actor.id,
        name: actor.displayName,
        agent: false,
        description: 'Here now',
        ready: true,
      })),
    ...(agents &&
    catalog.isSuccess &&
    catalog.data?.catalogState !== 'reconciling'
      ? (catalog.data?.agents ?? []).map((agent) => ({
          id: agent.slug,
          name: agent.name,
          agent: true,
          handle: agent.slug,
          ready: agent.available !== false,
          unavailableReason: 'Unavailable right now',
        }))
      : []),
  ];
  const mention = useRoomMention({
    candidates,
    enabled: !blocked && !recipient,
    onPick(candidate, query) {
      if (candidate.agent) {
        setRecipient({ id: candidate.id, name: candidate.name });
        setText(
          (current) => current.slice(0, query.start) + current.slice(query.end),
        );
      } else
        setText(
          (current) =>
            `${current.slice(0, query.start)}@${candidate.name} ${current.slice(query.end)}`,
        );
      composer.current?.focus();
    },
  });
  const tooLong =
    new TextEncoder().encode(text).length > PROJECT_ROOM_LIMITS.textBytes;
  const canSend = restored && !blocked && !!text.trim() && !tooLong;
  return (
    <>
      {agents && view.capabilities.discuss && (
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
          blocked={!restored || blocked}
          toolsSlot={toolsSlot}
          askRef={agentPanel}
          onAsked={(asked) => {
            // Clear only what was acknowledged: an edit made meanwhile stays.
            setText((current) => (current === asked.text ? '' : current));
            setRecipient((current) =>
              current?.id === asked.agentId ? undefined : current,
            );
            setReplyTo((current) =>
              current === asked.replyTo ? undefined : current,
            );
          }}
          prepareRecap={prepareRecap}
          refresh={refresh}
        />
      )}
      <RoomComposer
        id={id}
        label="Message the project"
        placeholder="Message # Project room"
        value={text}
        onValueChange={(value, caret) => {
          setText(value);
          setRecipientNotice('');
          mention.find(value, caret);
        }}
        onSend={() => {
          if (recipient) agentPanel.current?.ask(recipient.id);
          else send();
        }}
        canSend={canSend}
        pending={sending}
        sendLabel={recipient ? `Ask ${recipient.name}` : 'Send message'}
        textareaRef={composer}
        inputProps={{
          'aria-controls': mention.open ? `${id}-mentions` : undefined,
          'aria-activedescendant':
            mention.open && mention.filtered.length
              ? `${id}-mentions-option-${mention.selected}`
              : undefined,
          'aria-describedby': `${id}-help`,
          onKeyDown: mention.onKeyDown,
          onClick: (event) =>
            mention.find(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            ),
        }}
        above={
          replyTo || recipient ? (
            <>
              {replyTo && (
                <span className="room-composer__chip">
                  Replying to <strong>{replyAuthor}</strong>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    onClick={cancelReply}
                  >
                    Cancel reply
                  </Button>
                </span>
              )}
              {recipient && (
                <span className="room-composer__chip">
                  Asking <strong>@{recipient.name}</strong>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${recipient.name}`}
                    onClick={() => setRecipient(undefined)}
                  >
                    Remove
                  </Button>
                </span>
              )}
            </>
          ) : undefined
        }
        tools={
          <>
            <IconButton
              aria-label="Mention a person or agent"
              title="Mention a person or agent"
              className="room-composer__tool"
              disabled={blocked || !!recipient}
              onClick={() => {
                const field = composer.current;
                const caret = field?.selectionStart ?? text.length;
                const before = text.slice(0, caret);
                const insert = before && !/\s$/.test(before) ? ' @' : '@';
                const next = before + insert + text.slice(caret);
                setText(next);
                mention.openAt(caret + insert.length - 1);
                field?.focus();
              }}
            >
              <span aria-hidden="true">@</span>
            </IconButton>
            <span ref={setToolsSlot} className="room-composer__slot" />
          </>
        }
        below={
          <>
            <RoomMentionPicker
              id={`${id}-mentions`}
              state={mention}
              loading={agents && catalog.isPending}
              failed={agents && catalog.isError}
              onClearQuery={() => {
                const query = mention.mention;
                if (!query) return;
                setText(
                  (current) =>
                    `${current.slice(0, query.start)}@${current.slice(query.end)}`,
                );
                mention.openAt(query.start);
                composer.current?.focus();
              }}
            />
            <p className="sr-only" id={`${id}-help`}>
              Enter to send, Shift+Enter for a new line. Type @ to mention a
              person or agent.
            </p>
            {recipientNotice && (
              <p className="room-composer__status" role="status">
                {recipientNotice}
              </p>
            )}
            {tooLong && (
              <p className="room-composer__status" role="alert">
                This message is too long to send.
              </p>
            )}
          </>
        }
      />
    </>
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
  toolsSlot,
  askRef,
  onAsked,
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
  /** The composer's tool bar: Recap and Bring an Agent render there. */
  toolsSlot: HTMLElement | null;
  /** Lets an @agent pick in the composer ask through this same request path. */
  askRef: Ref<{ ask(agentId: string): void }>;
  /** An @agent request was acknowledged; the composer clears that snapshot. */
  onAsked(asked: { text: string; agentId: string; replyTo?: string }): void;
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
  async function act(
    action: 'request' | 'inspect' | 'reconcile' | 'cancel',
    mentioned?: string,
  ) {
    if (!ready || stopped || busy.current) return;
    let saved = retained;
    const chosen = mentioned ?? agentId;
    if (mentioned && retained) {
      // A new @agent ask never reuses the retained intent: that is only for
      // an explicit retry (#4810 review 2). One request is tracked at a time.
      const settled =
        handle?.state === 'published' || handle?.state === 'cancelled';
      if (!settled) {
        setNotice(
          'Finish or clear the current Agent request before asking again.',
        );
        return;
      }
      sessionStorage.removeItem(storageKey);
      setRetained(undefined);
      setHandle(undefined);
      saved = undefined;
    }
    if (!saved) {
      if (
        action !== 'request' ||
        blocked ||
        !available.some((a) => a.slug === chosen)
      )
        return;
      saved = {
        intent: parseProjectRoomAgentIntent({
          ...guard,
          intentId: randomCorrelationId(),
          agentId: chosen,
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
      if (mentioned)
        onAsked({
          text: saved.intent.text,
          agentId: saved.intent.agentId,
          ...(saved.intent.replyTo ? { replyTo: saved.intent.replyTo } : {}),
        });
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
  useImperativeHandle(askRef, () => ({
    ask: (mentionedAgent: string) =>
      void requestAction.current('request', mentionedAgent),
  }));
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

  const tools = retained ? null : (
    <>
      <Button
        size="sm"
        aria-label="Recap Project"
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
        <span className="room-composer__long">Recap Project</span>
        <span className="room-composer__short" aria-hidden="true">
          Recap
        </span>
      </Button>
      <Button
        size="sm"
        aria-label="Bring an Agent"
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
        <span className="room-composer__long">Bring an Agent</span>
        <span className="room-composer__short" aria-hidden="true">
          Agent
        </span>
      </Button>
    </>
  );
  return (
    <div className="project-room__agent">
      {toolsSlot ? createPortal(tools, toolsSlot) : tools}
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
      ) : null}
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
                Retry
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
