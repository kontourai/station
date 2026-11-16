import {
  isProjectRoomUuid,
  PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
  PROJECT_ROOM_FILES_UNAVAILABLE_CODE,
  PROJECT_ROOM_FORBIDDEN_CODE,
  PROJECT_ROOM_LIMITS,
  type ProjectRoomAttachment,
} from '@kontourai/station-contracts/project-room';
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  type ApiRequestScope,
  fetchProjectRoomAttachment,
  isProjectRoomAccessError,
  PROJECT_ROOM_HISTORY_MAX_PAGES,
  PROJECT_ROOM_RETAINED_REREAD_MESSAGES,
  type ProjectRoomAgentHandle,
  type ProjectRoomAgentIntent,
  type ProjectRoomBrowserView,
  type ProjectRoomMessageIntent,
  ProjectRoomProtocolError,
  parseProjectRoomAgentIntent,
  parseProjectRoomMessageIntent,
  uploadProjectRoomAttachments,
  useProjectRoom,
  useProjectRoomAgent,
  useProjectRoomChannels,
  useProjectRoomHistorySpan,
  useProjectRoomRetainedHistory,
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
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { IconButton } from '../../components/IconButton';
import {
  ArrowLeftGlyph,
  CheckGlyph,
  EditGlyph,
  PeopleGlyph,
  ReturnGlyph,
} from '../../components/icons/Glyph';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import {
  RoomAttachmentList,
  type RoomAttachmentSource,
} from '../../components/room/RoomAttachmentList';
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
  ReactGlyph,
  RoomEmojiPicker,
  RoomReactionBar,
  RoomReactionsSheet,
  type RoomReactionView,
  TrashGlyph,
} from '../../components/room/RoomReactions';
import { RoomThreadSummary } from '../../components/room/RoomThreadSummary';
import { useMarkRoomRead } from '../../components/room/useMarkRoomRead';
import {
  roomDraftKey,
  useRoomDraftValue,
} from '../../components/room/useRoomDraft';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { useProjectRoomMessageActions } from '../../hooks/useProjectRoomMessageActions';
import { useRoomAttachments } from '../../hooks/useRoomAttachments';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import './ProjectRoom.css';
import {
  type ChannelScreen,
  currentProjectRoomChannel,
  ProjectRoomChannelHeader,
} from './ProjectRoomChannels';

export interface ProjectRoomProps {
  slug: string;
  projectId: string;
  /** `draftRecoveryKey` is the shell's non-secret reload partition. */
  requestScope: ApiRequestScope & { draftRecoveryKey?: string };
  variant?: 'preview' | 'full';
  /** The preview's Open room, with the channel it shows. */
  onOpenRoom?(channelId: string | undefined): void;
  /**
   * The room destination's channel, owned by the route (#4795), so a link,
   * the sidebar and Back all address it; `id` absent is the default channel.
   * Without it the room remembers its own selection.
   */
  routeChannel?: { id: string | undefined };
  /** Called when the reader picks a channel the route should show. */
  onRouteChannel?(channelId: string | undefined): void;
  /**
   * Threads (#4795): the open thread's root message, owned by the route.
   * Without it replies stay inline, as in the Overview preview.
   */
  thread?: {
    rootId: string | undefined;
    open(rootId: string | undefined): void;
  };
  /** A phone's full-screen conversation (#4795): a back button replaces the page chrome. */
  screen?: { backLabel: string; onBack(): void };
}
function scopeKey(props: ProjectRoomProps) {
  return JSON.stringify([
    props.requestScope.apiBase,
    props.requestScope.authorityKey,
    props.projectId,
    props.slug,
  ]);
}
const SELECTED_CHANNEL_PREFIX = 'station-project-room-channel:';
function readSelectedChannel(key: string | undefined) {
  if (!key) return undefined;
  try {
    const value = sessionStorage.getItem(SELECTED_CHANNEL_PREFIX + key);
    return value && isProjectRoomUuid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function writeSelectedChannel(key: string | undefined, value?: string) {
  if (!key) return;
  try {
    if (value) sessionStorage.setItem(SELECTED_CHANNEL_PREFIX + key, value);
    else sessionStorage.removeItem(SELECTED_CHANNEL_PREFIX + key);
  } catch {
    // Storage refused: the selection lasts for this view only.
  }
}
/** Session keys that begin with `prefix`, read before any is removed. */
function storageKeysWith(prefix: string) {
  const keys: string[] = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}
export function ProjectRoom(props: ProjectRoomProps) {
  const key = scopeKey(props);
  const partition =
    props.requestScope.draftRecoveryKey ?? props.requestScope.authorityKey;
  // Drafts follow the reload partition, not the activation epoch in `key`,
  // which changes on every reload (#4810 review 1). `#general` keeps the
  // room's original key; another channel adds its identity (#4792).
  const roomKey = roomDraftKey(
    partition,
    props.requestScope.apiBase,
    props.projectId,
    props.slug,
    'project-room',
  );
  // The channel on screen, remembered per reload partition so a reload
  // returns to it; absent is the default channel.
  const [selection, setSelection] = useState(() => ({
    roomKey,
    channelId: readSelectedChannel(roomKey),
  }));
  const remembered =
    selection.roomKey === roomKey
      ? selection.channelId
      : readSelectedChannel(roomKey);
  const routeOwned = !!props.routeChannel;
  const routeChannelId = props.routeChannel?.id;
  const channelId = routeOwned ? routeChannelId : remembered;
  // The route's channel is also the one the Overview preview shows next.
  useEffect(() => {
    if (routeOwned) writeSelectedChannel(roomKey, routeChannelId);
  }, [routeOwned, routeChannelId, roomKey]);
  const { onRouteChannel } = props;
  const selectChannel = useCallback(
    (next: string | undefined) => {
      writeSelectedChannel(roomKey, next);
      setSelection({ roomKey, channelId: next });
      onRouteChannel?.(next);
    },
    [roomKey, onRouteChannel],
  );
  const draftKey = channelId
    ? roomDraftKey(
        partition,
        props.requestScope.apiBase,
        props.projectId,
        props.slug,
        'project-room',
        'channel',
        channelId,
      )
    : roomKey;
  // Each channel is its own session: drafts and retained sends stay per room.
  const storageKey = `station-project-room:${key}${channelId ? `:channel:${channelId}` : ''}`;
  const previous = useRef({ key, roomKey });
  useLayoutEffect(() => {
    const prior = previous.current;
    if (prior.key !== key) {
      // Authority switches retire the prior browser's retained proposals,
      // in every channel.
      try {
        for (const stale of storageKeysWith(
          `station-project-room:${prior.key}`,
        ))
          sessionStorage.removeItem(stale);
        // A different partition (another credential) retires its drafts and
        // channel selection too.
        if (prior.roomKey && prior.roomKey !== roomKey) {
          for (const stale of storageKeysWith(
            `station-room-draft:${prior.roomKey.slice(0, -1)}`,
          ))
            sessionStorage.removeItem(stale);
          sessionStorage.removeItem(SELECTED_CHANNEL_PREFIX + prior.roomKey);
        }
      } catch {
        /* Sending requires successful storage separately. */
      }
    }
    previous.current = { key, roomKey };
  }, [key, roomKey]);
  return (
    <ProjectRoomSession
      key={storageKey}
      {...props}
      storageKey={storageKey}
      draftKey={draftKey}
      channelId={channelId}
      onSelectChannel={selectChannel}
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
  /**
   * The on-screen keyboard covers the dock's band too, so while it is open
   * the room reserves nothing for the dock: the composer's lift (the
   * keyboard's height) then lands it on the keyboard's top edge, with no
   * band between them, on a phone's full-screen room as on the page (#4795).
   */
  keyboardOpen = false,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const update = () => {
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;height:calc(var(--dock-slot-size, 0px) + var(--safe-bottom, 0px))';
      element.append(probe);
      const clearance = keyboardOpen ? 0 : probe.getBoundingClientRect().height;
      probe.remove();
      // Where the room starts with every ancestor scrolled to its top.
      let top = element.getBoundingClientRect().top;
      for (let node = element.parentElement; node; node = node.parentElement)
        top += node.scrollTop;
      const below = parseFloat(
        getComputedStyle(element.closest('.project-page__layout') ?? element)
          .paddingBottom,
      );
      // A floor, not a fixed height: when the room's chrome leaves too
      // little for the messages, the room grows and the page scrolls.
      element.style.minHeight = `${Math.max(
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
      element.style.minHeight = '';
    };
  }, [ref, enabled, keyboardOpen]);
}
const ROOM_MIN_HEIGHT_PX = 320;

/** One history read: its messages, and its place in the SDK read order. */
type HistoryRead = { messages: RoomMessage[]; readSeq: number };
type RoomMessage = NonNullable<
  ReturnType<typeof useProjectRoom>['history']['data']
>['pages'][number]['messages'][number];

/**
 * Messages already shown for this room. The history window is keyed by the
 * room's latest sequence, so each new message starts a fresh query; keeping
 * the rows already read stops the list from emptying and losing the reader's
 * place while the new window loads.
 *
 * Rows kept from a window the room has moved past are owned by no history
 * query, so `reread` brings them up to date (#4797): each new read of that
 * span is applied once, and the live windows always win over it. A kept row
 * older than the re-read span is retired rather than shown stale, and
 * `unloaded` says so until the reader loads earlier messages again; an open
 * thread whose root is retired seeks it again from the live history, within
 * the windows a room keeps (#4855).
 */
function useRoomMessages(
  roomId: string | undefined,
  pages: HistoryRead[],
  reread: HistoryRead | undefined,
  recheck: HistoryRead | undefined,
) {
  const retained = useRef<{
    roomId?: string;
    byId: Map<string, RoomMessage>;
    /** The SDK read order of the read that last set each row. */
    readById: Map<string, number>;
    rereadSeq?: number;
    recheckSeq?: number;
    live: Set<string>;
    unloaded?: boolean;
  }>({ byId: new Map(), readById: new Map(), live: new Set() });
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  if (retained.current.roomId !== roomId)
    retained.current = {
      roomId,
      byId: new Map(),
      readById: new Map(),
      rereadSeq: reread?.readSeq,
      recheckSeq: recheck?.readSeq,
      live: new Set(),
    };
  // A read that started earlier never replaces what a later one set, from
  // whichever source either came (#4852 review).
  const put = (read: HistoryRead) => {
    for (const message of read.messages)
      if (
        (retained.current.readById.get(message.messageId) ?? 0) <= read.readSeq
      ) {
        retained.current.byId.set(message.messageId, message);
        retained.current.readById.set(message.messageId, read.readSeq);
      }
  };
  for (const source of [
    { read: reread, key: 'rereadSeq' as const },
    { read: recheck, key: 'recheckSeq' as const },
  ])
    if (source.read && retained.current[source.key] !== source.read.readSeq) {
      retained.current[source.key] = source.read.readSeq;
      put(source.read);
    }
  for (const page of pages) put(page);
  const fetched = pages.flatMap((page) => page.messages);
  if (fetched.length) {
    const refreshable =
      Math.min(...fetched.map((message) => message.seq)) -
      1 -
      PROJECT_ROOM_RETAINED_REREAD_MESSAGES;
    for (const [id, message] of retained.current.byId)
      if (message.seq <= refreshable) {
        retained.current.byId.delete(id);
        retained.current.readById.delete(id);
        retained.current.unloaded = true;
      }
  }
  // Rows that were live and no longer are: their last read may be from a
  // window whose refresh was cancelled as the tail moved, so they are read
  // again now rather than at the next live event (#4852 review).
  const live = new Set(fetched.map((message) => message.messageId));
  const left = [...retained.current.live]
    .filter((id) => !live.has(id))
    .map((id) => retained.current.byId.get(id))
    .filter((message): message is RoomMessage => !!message)
    .map((message) => message.seq);
  retained.current.live = live;
  return {
    messages: [...retained.current.byId.values()].sort((a, b) => a.seq - b.seq),
    unloaded: !!retained.current.unloaded,
    /** Rows that just left the live windows, to be read again. */
    left: left.length
      ? { after: Math.min(...left) - 1, end: Math.max(...left) }
      : undefined,
    /** Earlier messages loaded again: the unloaded notice is done. */
    acknowledgeUnloaded: () => {
      if (!retained.current.unloaded) return;
      retained.current.unloaded = false;
      rerender();
    },
  };
}
/**
 * The shown rows older than every live history window: the span the retained
 * re-read covers, through the message just before the oldest live one.
 */
function retainedSpan(
  shown: RoomMessage[],
  fetched: RoomMessage[],
): { after: number; end: number } | undefined {
  if (!fetched.length) return undefined;
  const oldestLive = Math.min(...fetched.map((message) => message.seq));
  const oldestShown = shown[0]?.seq;
  return oldestShown !== undefined && oldestShown < oldestLive
    ? { after: oldestShown - 1, end: oldestLive - 1 }
    : undefined;
}

/** What a Project room keeps for an unsent message (#4810 review 3). */
interface ProjectRoomDraft {
  text: string;
  replyTo?: string;
  recipient?: { id: string; name: string };
  /**
   * This edit's identity (#4855): new on every edit and kept through
   * storage, so an acknowledgement clears only the exact revision it was
   * asked from, never a later draft retyped to the same text.
   */
  revision?: string;
}
/** A draft edit: the next envelope, with an identity of its own. */
function revised(draft: ProjectRoomDraft): ProjectRoomDraft {
  return { ...draft, revision: randomCorrelationId() };
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
      ...(typeof draft.revision === 'string' &&
      draft.revision.length > 0 &&
      draft.revision.length <= 64
        ? { revision: draft.revision }
        : {}),
    };
  },
  isEmpty: (draft: ProjectRoomDraft) =>
    !draft.text && !draft.replyTo && !draft.recipient,
};
/** A person's own message being edited in the composer (#4797). */
interface ProjectRoomEdit {
  messageId: string;
  /** The text the edit started from; saving it unchanged is a no-op. */
  original: string;
  text: string;
  /** Files stay on the message, so its text may be emptied. */
  hasFiles: boolean;
}
/** What a refused reaction, edit or delete tells the person. */
function messageActionFailure(error: unknown, action: string) {
  const code = error instanceof StationHttpError ? error.code : undefined;
  if (code === 'project_room_capacity')
    return action === 'react'
      ? 'This message has all the reactions it can hold.'
      : 'This message cannot be edited again.';
  if (code === PROJECT_ROOM_FORBIDDEN_CODE)
    return 'You can change only your own messages.';
  if (code === 'project_room_conflict')
    return 'That message changed. The conversation has been refreshed.';
  return action === 'react'
    ? 'The reaction was not saved. Try again.'
    : action === 'edit'
      ? 'The edit was not saved. Your text is still in the composer.'
      : 'The message was not deleted. Try again.';
}
/** An open thread's own draft key: its channel's draft key plus the root. */
function threadDraftKey(key: string | undefined, root: string | undefined) {
  if (!key || !root) return key;
  return JSON.stringify([...(JSON.parse(key) as string[]), 'thread', root]);
}
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
  channelId,
  onSelectChannel,
  thread,
  screen,
  routeChannel,
}: ProjectRoomProps & {
  storageKey: string;
  draftKey: string | undefined;
  /** The channel on screen; absent is the Project's default channel. */
  channelId: string | undefined;
  onSelectChannel(channelId: string | undefined): void;
}) {
  const editorId = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
  const section = useRef<HTMLElement>(null);
  const compact = useIsMobile();
  const room = useProjectRoom(requestScope, slug, projectId, channelId);
  const channels = useProjectRoomChannels(requestScope, slug, projectId);
  const channel = currentProjectRoomChannel(channels.list.data, channelId);
  const channelName = channel?.name ?? PROJECT_ROOM_DEFAULT_CHANNEL_NAME;
  const archived = !!channel?.archivedAt;
  const discovered = room.discovery.data;
  // An archived channel serves history only: no composer, Agent asks or notes.
  const view = useMemo(
    () =>
      discovered && archived
        ? {
            ...discovered,
            capabilities: {
              ...discovered.capabilities,
              discuss: false,
              edit: false,
              execute: false,
            },
          }
        : discovered,
    [discovered, archived],
  );
  // A channel that no longer exists for this Project, or a host that has no
  // channels at all, falls back to #general.
  const channelMissing =
    channelId !== undefined &&
    (channels.unsupported || (!!channels.list.data && !channel));
  useEffect(() => {
    if (channelMissing) onSelectChannel(undefined);
  }, [channelMissing, onSelectChannel]);
  const [tab, setTab] = useState<'conversation' | 'notes'>('conversation');
  const threadsOn = variant === 'full' && !!thread;
  const threadRoot = threadsOn ? thread?.rootId : undefined;
  // Text, reply target and Agent recipient are restored together; the
  // recipient is revalidated against the live catalog before it is used. An
  // open thread keeps its own draft, so unsent text never moves between a
  // thread and its channel and never changes destination (#4855).
  const [draft, setDraft] = useRoomDraftValue(
    threadDraftKey(draftKey, threadRoot),
    EMPTY_PROJECT_DRAFT,
    PROJECT_DRAFT_CODEC,
  );
  const { text, replyTo, recipient } = draft;
  const setText = useCallback(
    (update: Update<string>) =>
      setDraft((current) =>
        revised({ ...current, text: apply(update, current.text) }),
      ),
    [setDraft],
  );
  const setReplyTo = useCallback(
    (update: Update<string | undefined>) =>
      setDraft(({ replyTo: previous, ...rest }) => {
        const next = apply(update, previous);
        return revised(next ? { ...rest, replyTo: next } : rest);
      }),
    [setDraft],
  );
  // Clears the whole envelope only if it is still the revision that was
  // asked; any edit since (text, recipient or reply) keeps the newer draft
  // intact (#4810 delta 1), even one retyped to the same text (#4855). The
  // revision's identity survives storage, so it also holds when a late
  // acknowledgement lands after the reader left this draft's thread or
  // channel and the setter reads that draft back (`useRoomDraftValue`).
  const clearDraftIfCurrent = useCallback(
    (asked: ProjectRoomDraft) =>
      setDraft((current) =>
        current === asked ||
        (asked.revision !== undefined && current.revision === asked.revision)
          ? EMPTY_PROJECT_DRAFT
          : current,
      ),
    [setDraft],
  );
  const setRecipient = useCallback(
    (update: Update<ProjectRoomDraft['recipient']>) =>
      setDraft(({ recipient: previous, ...rest }) => {
        const next = apply(update, previous);
        return revised(next ? { ...rest, recipient: next } : rest);
      }),
    [setDraft],
  );
  // A draft stored before revisions existed loads without one. Give it a
  // fresh revision and persist it before it can be asked, so a late
  // acknowledgement can still clear exactly that draft (#4855); the
  // comparison itself stays identity-only.
  const unrevised = !draft.revision && !PROJECT_DRAFT_CODEC.isEmpty(draft);
  useEffect(() => {
    if (!unrevised) return;
    setDraft((current) =>
      current.revision || PROJECT_DRAFT_CODEC.isEmpty(current)
        ? current
        : revised(current),
    );
  }, [unrevised, setDraft]);
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
  // Reactions, edits, deletes and files (#4796, #4797, #4812) need a host
  // that serves them; an older one keeps the room as it was. Only an open
  // room asks: one that is missing or unavailable has nothing to act on.
  const messageActions = useProjectRoomMessageActions(
    requestScope.apiBase,
    !!view,
  );
  const [editing, setEditing] = useState<ProjectRoomEdit>();
  const [picker, setPicker] = useState<string>();
  const [reactionsFor, setReactionsFor] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const popoverAnchor = useRef<HTMLElement | null>(null);
  const roomIdForFiles = view?.roomId;
  const actorForFiles = view?.actor.id;
  const roomStopped = useRef(room.stopped);
  roomStopped.current = room.stopped;
  const fileTarget = useMemo(
    () =>
      messageActions && roomIdForFiles && actorForFiles
        ? {
            owner: [
              requestScope.apiBase,
              requestScope.authorityKey,
              projectId,
              roomIdForFiles,
              actorForFiles,
            ],
            label: 'Room',
            isCurrent: () => !roomStopped.current,
            upload: (
              attachments: Parameters<
                typeof uploadProjectRoomAttachments
              >[2]['attachments'],
            ) =>
              uploadProjectRoomAttachments(
                requestScope,
                slug,
                {
                  expectedRoomId: roomIdForFiles,
                  expectedProjectId: projectId,
                  expectedActorId: actorForFiles,
                  attachments,
                },
                channelId,
              ),
          }
        : undefined,
    [
      messageActions,
      roomIdForFiles,
      actorForFiles,
      requestScope,
      projectId,
      slug,
      channelId,
    ],
  );
  // Staged files go where the draft goes: a thread and its channel each keep
  // their own, so a file chosen in a thread never rides a channel send.
  const files = useRoomAttachments(
    fileTarget,
    () => setNotice(''),
    JSON.stringify([channelId ?? null, threadRoot ?? null]),
  );
  const fileSource = useMemo<RoomAttachmentSource>(
    () => ({
      key: [
        'project',
        requestScope.apiBase,
        requestScope.authorityKey,
        projectId,
        roomIdForFiles,
      ],
      enabled: !!roomIdForFiles,
      isCurrent: () => !roomStopped.current,
      load: (attachment, signal) =>
        fetchProjectRoomAttachment(
          requestScope,
          slug,
          attachment.id,
          channelId,
          signal,
        ),
    }),
    [requestScope, projectId, roomIdForFiles, slug, channelId],
  );
  // Starting an edit puts the caret at the end of the message's text.
  const editingId = editing?.messageId;
  useEffect(() => {
    const field = composer.current;
    if (!editingId || !field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editingId]);
  // An edit belongs to the conversation it started in; leaving that thread
  // or channel ends it, as it would a reply.
  useEffect(() => {
    void threadRoot;
    void channelId;
    setEditing(undefined);
  }, [threadRoot, channelId]);
  const keyboardOpen = useMobileVisualViewport().bottomInset > 0;
  useFillPageHeight(
    section,
    variant === 'full' && !!view,
    compact && keyboardOpen,
  );
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
  // Switching channels is a local state change, so it asks through the same
  // guard when an unconfirmed send or a notes draft would be left behind.
  const phone = variant === 'full' && screen ? screen : undefined;
  /** The phone's bar (#4795): back, then the channel; `extra` adds faces and commands. */
  const screenBar = (
    extra?: Partial<ChannelScreen>,
  ): ChannelScreen | undefined =>
    phone
      ? {
          backLabel: phone.backLabel,
          onBack: phone.onBack,
          actions: [],
          ...extra,
        }
      : undefined;
  const channelHeader = (bar = screenBar()) => (
    <div className="project-room__title">
      <ProjectRoomChannelHeader
        channels={channels}
        current={channel}
        canEdit={!!discovered?.capabilities.edit}
        guards={
          discovered
            ? {
                expectedProjectId: projectId,
                expectedActorId: discovered.actor.id,
              }
            : undefined
        }
        // A route-owned switch is a navigation, which asks the same guard
        // once; a remembered one is local state and asks here.
        onSelect={(next) =>
          routeChannel
            ? onSelectChannel(next)
            : guard(() => onSelectChannel(next))
        }
        projectSlug={slug}
        screen={bar}
      />
    </div>
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
    setEditing(undefined);
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
      setEditing(undefined);
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
  const shownRoomId = room.stopped ? undefined : view?.roomId;
  const liveReads = room.history.data?.pages ?? [];
  const fetchedMessages = liveReads.flatMap((page) => page.messages);
  // Asked when the room changes (a live event or a mutation), for the rows
  // shown at the last render.
  const olderShown = useRef<{ after: number; end: number }>(undefined);
  const reread = useProjectRoomRetainedHistory(
    requestScope,
    slug,
    projectId,
    channelId,
    shownRoomId,
    () => olderShown.current,
  );
  // Rows that just left the live windows are read again at once.
  const [leftSpan, setLeftSpan] = useState<{ after: number; end: number }>();
  const recheck = useProjectRoomHistorySpan(
    requestScope,
    slug,
    projectId,
    channelId,
    shownRoomId,
    leftSpan,
  );
  const {
    messages,
    unloaded: earlierUnloaded,
    left,
    acknowledgeUnloaded,
  } = useRoomMessages(shownRoomId, liveReads, reread.data, recheck.data);
  olderShown.current = retainedSpan(messages, fetchedMessages);
  const leftAfter = left?.after;
  const leftEnd = left?.end;
  useEffect(() => {
    if (leftAfter === undefined || leftEnd === undefined) return;
    setLeftSpan({ after: leftAfter, end: leftEnd });
  }, [leftAfter, leftEnd]);
  // Every send and Agent ask from an open thread replies to its root, read
  // from the route on each send rather than kept in the draft (#4795).
  const replyTarget = threadRoot ?? replyTo;
  // Marks read only what the channel has shown (#3075, #4794): the newest
  // message of a history read that succeeded. Room seqs count messages, so
  // that is the version on screen. A held or failed read, or a thread
  // showing part of the channel, acknowledges nothing.
  const shownThrough = room.history.isSuccess
    ? room.history.data?.pages[0]?.messages.at(-1)?.seq
    : undefined;
  useMarkRoomRead(
    view
      ? { kind: 'project-room', projectSlug: slug, roomId: view.roomId }
      : undefined,
    shownThrough,
    variant === 'full' &&
      tab === 'conversation' &&
      !threadRoot &&
      !room.stopped,
  );
  // A thread link can name a root older than the newest window: page back
  // to it, within the windows a room keeps loaded.
  const historyPages = room.history.data?.pages.length ?? 0;
  const threadRootLoaded =
    !!threadRoot &&
    messages.some((message) => message.messageId === threadRoot);
  const threadBeyondWindow =
    !!threadRoot &&
    !threadRootLoaded &&
    !!room.history.hasNextPage &&
    historyPages >= PROJECT_ROOM_HISTORY_MAX_PAGES;
  // Paging back stops where the seek does: a page past the bound would drop
  // the newest window while its rows stayed on screen with nothing to
  // refresh them. Both limits are said, never silent.
  const olderInHistory = variant === 'full' && !!room.history.hasNextPage;
  const olderLoadable =
    olderInHistory && historyPages < PROJECT_ROOM_HISTORY_MAX_PAGES;
  const olderNote =
    olderInHistory && !olderLoadable
      ? `This view keeps the latest ${PROJECT_ROOM_RETAINED_REREAD_MESSAGES} messages.`
      : earlierUnloaded && olderLoadable
        ? 'Earlier messages were unloaded to keep this view current.'
        : undefined;
  const awaitingThreadRoot =
    !!threadRoot &&
    !threadRootLoaded &&
    !!room.history.hasNextPage &&
    historyPages < PROJECT_ROOM_HISTORY_MAX_PAGES;
  // While the root is missing, the query is idle and successful, a next
  // cursor exists and the bound allows, fetch the next window. Progress is
  // read from the history result itself (how many windows are loaded and the
  // oldest cursor), plus a counter each fetch started here bumps when it
  // settles, so a page cancelled by a live refetch is re-checked too. Never a
  // clock: two reads can share a timestamp (#4855). `cancelRefetch: false`
  // joins a fetch already in flight rather than starting a second one.
  const {
    fetchNextPage,
    isFetching: historyFetching,
    isError: historyFailed,
  } = room.history;
  // The oldest loaded window's first message: moves with every older page.
  const oldestCursor = room.history.data?.pages.at(-1)?.messages[0]?.seq;
  const [seekSettled, setSeekSettled] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loaded windows, the oldest cursor and each settled fetch re-check for the root.
  useEffect(() => {
    if (!awaitingThreadRoot || historyFetching || historyFailed) return;
    void fetchNextPage({ cancelRefetch: false }).finally(() =>
      setSeekSettled((count) => count + 1),
    );
  }, [
    awaitingThreadRoot,
    historyFetching,
    historyFailed,
    historyPages,
    oldestCursor,
    seekSettled,
    fetchNextPage,
  ]);
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
    if (!view || room.stopped || !restored || unrevised || room.send.isPending)
      return;
    if (proposal && !retry) return;
    // Files upload first; the message then names them by their stored ids.
    // The files are the ones staged where this send started, even if the
    // reader moves to another thread or channel before the upload finishes.
    const filesFor = files.destination;
    let attachments: ProjectRoomAttachment[] = [];
    if (!retry && files.files.length) {
      try {
        attachments = await files.prepare(filesFor);
      } catch (error) {
        // The room's file store is paused for repair (#4852): say so, and
        // that the text still sends without the files.
        files.setError(
          error instanceof StationHttpError &&
            error.code === PROJECT_ROOM_FILES_UNAVAILABLE_CODE
            ? 'Attachments are paused for now. Remove the files to send your message.'
            : 'The files were not uploaded. Try sending again.',
          filesFor,
        );
        return;
      }
      if (!mounted.current) return;
    }
    const input = retry ?? {
      expectedRoomId: view.roomId,
      expectedProjectId: projectId,
      expectedActorId: view.actor.id,
      intentId: randomCorrelationId(),
      text,
      ...(replyTarget ? { replyTo: replyTarget } : {}),
      ...(attachments.length ? { attachments } : {}),
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
      files.clear(filesFor);
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
    // An open thread's root comes from the route; only a channel reply is
    // restored to the draft.
    setReplyTo(
      (current) =>
        current ??
        (retained.replyTo === threadRoot ? undefined : retained.replyTo),
    );
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
  const roomClass = `project-room${phone ? ' project-room--screen' : ''}`;
  if (room.stopped)
    return (
      <section className={roomClass} aria-label="Project room">
        {phone && channelHeader()}
        <p role="status">
          Room access changed. Your draft was cleared. Check access to continue.
        </p>
        <Button onClick={room.recover}>Check access</Button>
      </section>
    );
  if (room.unprovisioned)
    return (
      <section className={roomClass} aria-label="Project room">
        {channelHeader()}
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
  // The Project is not on this Station (#4855): not an outage, so no retry.
  if (room.projectMissing)
    return (
      <section className={roomClass} aria-label="Project room">
        {phone && channelHeader()}
        <Empty variant="compact" label="This Project isn't on this Station." />
      </section>
    );
  if (room.discovery.isError)
    return (
      <section className={roomClass} aria-label="Project room">
        {phone && channelHeader()}
        <ErrorState
          variant="compact"
          title="Room unavailable. Check your connection and Project access."
          action={<Button onClick={room.recover}>Retry</Button>}
        />
      </section>
    );
  if (!view)
    return (
      <section className={roomClass} aria-label="Project room">
        {phone && channelHeader()}
        <SkeletonBlock count={2} label="Loading room" />
      </section>
    );
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  /** A reply's thread is its earliest loaded ancestor (#4795). */
  const rootOf = (messageId: string) => {
    let id = messageId;
    for (let depth = 0; depth < 32; depth += 1) {
      const parent = byId.get(id)?.replyTo;
      if (!parent || !byId.has(parent)) break;
      id = parent;
    }
    return id;
  };
  // With threads on, a reply whose root is loaded lives in that root's
  // thread; one whose root is not loaded stays inline, quoting it.
  const repliesByRoot = new Map<string, RoomMessage[]>();
  if (threadsOn)
    for (const message of messages) {
      if (!message.replyTo || !byId.has(message.replyTo)) continue;
      const root = rootOf(message.messageId);
      repliesByRoot.set(root, [...(repliesByRoot.get(root) ?? []), message]);
    }
  const threaded = new Set(
    [...repliesByRoot.values()].flat().map((message) => message.messageId),
  );
  const openThread = threadRoot ? byId.get(threadRoot) : undefined;
  const channelMessages = threadsOn
    ? messages.filter((message) => !threaded.has(message.messageId))
    : messages;
  const visibleMessages =
    variant === 'preview' ? channelMessages.slice(-5) : channelMessages;
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
  const me = view.actor;
  const guards = {
    expectedRoomId: view.roomId,
    expectedProjectId: projectId,
    expectedActorId: me.id,
  };
  // Reacting, editing and deleting need the host's support and discuss.
  const canAct = messageActions && view.capabilities.discuss;
  /** A person's own message that still stands; Agent messages never are. */
  const isOwn = (message: RoomMessage) =>
    message.actor.kind === 'person' &&
    message.actor.id === me.id &&
    !message.deletedAt;
  const reactionViews = (message: RoomMessage): RoomReactionView[] =>
    (message.reactions ?? []).map((reaction) => ({
      emoji: reaction.emoji,
      mine: reaction.actors.some(
        (actor) => actor.id === me.id && actor.kind === me.kind,
      ),
      names: reaction.actors.map((actor) =>
        actor.id === me.id && actor.kind === me.kind
          ? 'You'
          : actor.displayName,
      ),
    }));
  const react = (messageId: string, emoji: string, reacted: boolean) =>
    room.react.mutate(
      { target: { ...guards, messageId }, emoji, reacted },
      {
        onError: (error) => {
          if (mounted.current) setNotice(messageActionFailure(error, 'react'));
        },
      },
    );
  const openPopover = (
    open: (messageId: string) => void,
    messageId: string,
    anchor: HTMLElement,
  ) => {
    popoverAnchor.current = anchor;
    open(messageId);
  };
  const startEdit = (message: RoomMessage) => {
    setNotice('');
    setEditing({
      messageId: message.messageId,
      original: message.text,
      text: message.text,
      hasFiles: !!message.attachments?.length,
    });
  };
  async function saveEdit() {
    if (!editing || room.edit.isPending) return;
    const current = editing;
    if (current.text === current.original) {
      setEditing(undefined);
      return;
    }
    try {
      await room.edit.mutateAsync({
        target: { ...guards, messageId: current.messageId },
        intentId: randomCorrelationId(),
        text: current.text,
      });
      if (mounted.current)
        setEditing((value) =>
          value?.messageId === current.messageId ? undefined : value,
        );
    } catch (error) {
      if (mounted.current) setNotice(messageActionFailure(error, 'edit'));
    }
  }
  async function confirmDelete() {
    const messageId = deleting;
    if (!messageId || room.remove.isPending) return;
    try {
      await room.remove.mutateAsync({
        target: { ...guards, messageId },
        intentId: randomCorrelationId(),
      });
      if (!mounted.current) return;
      setEditing((value) =>
        value?.messageId === messageId ? undefined : value,
      );
    } catch (error) {
      if (mounted.current) setNotice(messageActionFailure(error, 'delete'));
    } finally {
      if (mounted.current) setDeleting(undefined);
    }
  }
  const toRow = (
    message: RoomMessage,
    inThread = false,
  ): RoomConversationRow => {
    const replies = inThread
      ? []
      : (repliesByRoot.get(message.messageId) ?? []);
    const repliers = [
      ...new Map(
        replies.map((reply) => [
          reply.actor.id,
          {
            key: reply.actor.id,
            label: reply.actor.displayName,
            agent: reply.actor.kind === 'agent',
          },
        ]),
      ).values(),
    ];
    const name = message.actor.displayName;
    const reactions = reactionViews(message);
    const showReactions = (anchor: HTMLElement) =>
      openPopover(setReactionsFor, message.messageId, anchor);
    // With threads on, Reply from the channel opens the message's thread.
    const replyInThread = threadsOn && !inThread && !!thread;
    const reply = () => {
      if (replyInThread) {
        thread?.open(rootOf(message.messageId));
        return;
      }
      if (!inThread) setReplyTo(message.messageId);
      composer.current?.focus();
    };
    const replyLabel = replyInThread ? 'Reply in thread' : 'Reply';
    const live = view.capabilities.discuss && !message.deletedAt;
    return {
      id: message.messageId,
      kind: 'message',
      author: {
        id: message.actor.id,
        label: name,
        agent: message.actor.kind === 'agent',
      },
      at: message.createdAt,
      reply: !inThread && !!message.replyTo,
      context:
        !inThread && message.replyTo
          ? replyContext(message.replyTo)
          : undefined,
      text: message.text,
      editedAt: message.editedAt,
      // A tombstone keeps its place, and its thread stays reachable below it.
      deleted: !!message.deletedAt,
      highlighted: editing?.messageId === message.messageId,
      own: message.actor.id === view.actor.id,
      attachments: (
        <RoomAttachmentList
          attachments={message.attachments}
          source={fileSource}
        />
      ),
      reactions: reactions.length ? (
        <RoomReactionBar
          reactions={reactions}
          disabled={!canAct}
          onToggle={(emoji, reacted) =>
            react(message.messageId, emoji, reacted)
          }
          onAdd={
            canAct
              ? (anchor) => openPopover(setPicker, message.messageId, anchor)
              : undefined
          }
          onShowWho={showReactions}
        />
      ) : undefined,
      // Touch and phones: the same actions as labelled menu rows (no
      // tooltips there), Delete last and destructive.
      menu: live
        ? [
            ...(canAct
              ? [
                  {
                    key: 'react',
                    label: 'React',
                    glyph: <ReactGlyph />,
                    onSelect: (trigger: HTMLElement) =>
                      openPopover(setPicker, message.messageId, trigger),
                  },
                ]
              : []),
            {
              key: 'reply',
              label: replyLabel,
              glyph: <ReturnGlyph />,
              disabled: room.send.isPending,
              onSelect: reply,
            },
            ...(canAct && isOwn(message)
              ? [
                  {
                    key: 'edit',
                    label: 'Edit',
                    glyph: <EditGlyph />,
                    disabled: !!proposal,
                    onSelect: () => startEdit(message),
                  },
                  {
                    key: 'delete',
                    label: 'Delete',
                    glyph: <TrashGlyph />,
                    tone: 'danger' as const,
                    onSelect: () => setDeleting(message.messageId),
                  },
                ]
              : []),
            ...(reactions.length
              ? [
                  {
                    key: 'who-reacted',
                    label: 'Who reacted',
                    glyph: <PeopleGlyph />,
                    onSelect: (trigger: HTMLElement) => showReactions(trigger),
                  },
                ]
              : []),
          ]
        : undefined,
      footer:
        replies.length && thread ? (
          <RoomThreadSummary
            repliers={repliers}
            count={replies.length}
            lastAt={replies.at(-1)?.createdAt}
            onOpen={() => thread.open(message.messageId)}
          />
        ) : undefined,
      // Desktop: icon actions named by label and tooltip (#3045 keeps a row
      // to two labelled actions). A tombstone takes none.
      actions: live ? (
        <>
          {canAct && (
            <IconButton
              aria-label={`React to ${name}`}
              title="React"
              onClick={(event) =>
                openPopover(setPicker, message.messageId, event.currentTarget)
              }
            >
              <ReactGlyph />
            </IconButton>
          )}
          <IconButton
            disabled={room.send.isPending}
            aria-label={`Reply to ${name}`}
            title={replyLabel}
            onClick={reply}
          >
            <ReturnGlyph />
          </IconButton>
          {canAct && isOwn(message) && (
            <>
              <IconButton
                aria-label="Edit message"
                title="Edit"
                disabled={!!proposal}
                onClick={() => startEdit(message)}
              >
                <EditGlyph />
              </IconButton>
              <IconButton
                aria-label="Delete message"
                title="Delete"
                onClick={() => setDeleting(message.messageId)}
              >
                <TrashGlyph />
              </IconButton>
            </>
          )}
        </>
      ) : undefined,
    };
  };
  const proposalRoot =
    proposal?.replyTo && byId.has(proposal.replyTo)
      ? rootOf(proposal.replyTo)
      : undefined;
  const proposalInThread =
    !!openThread && threadsOn && proposalRoot === threadRoot;
  const proposalRow = (inThread: boolean): RoomConversationRow | undefined =>
    proposal && !committed
      ? {
          id: `proposal:${proposal.intentId}`,
          kind: 'message',
          author: {
            id: view.actor.id,
            label: view.actor.displayName,
            agent: view.actor.kind === 'agent',
          },
          reply: !inThread && !!proposal.replyTo,
          context:
            !inThread && proposal.replyTo
              ? replyContext(proposal.replyTo)
              : undefined,
          text: proposal.text,
          attachments: proposal.attachments?.length ? (
            <ul className="room-attachments" aria-label="Attached files">
              {proposal.attachments.map((file) => (
                <li key={file.id}>
                  <span>{file.name}</span>
                </li>
              ))}
            </ul>
          ) : undefined,
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
        }
      : undefined;
  const rows: RoomConversationRow[] = visibleMessages.map((message) =>
    toRow(message),
  );
  const pendingRow = proposalRow(proposalInThread);
  if (pendingRow && !proposalInThread) rows.push(pendingRow);
  const threadReplies = openThread
    ? (repliesByRoot.get(openThread.messageId) ?? [])
    : [];
  const threadRows: RoomConversationRow[] = openThread
    ? [
        toRow(openThread, true),
        // The root, then its replies under a quiet count.
        ...(threadReplies.length
          ? [
              {
                id: `thread-replies:${openThread.messageId}`,
                kind: 'system' as const,
                text: `${threadReplies.length} ${threadReplies.length === 1 ? 'reply' : 'replies'}`,
              },
            ]
          : []),
        ...threadReplies.map((message) => toRow(message, true)),
        ...(pendingRow && proposalInThread ? [pendingRow] : []),
      ]
    : [];
  const shownMessages = openThread
    ? [openThread, ...threadReplies]
    : visibleMessages;
  const lastOwnMessage = [...shownMessages].reverse().find(isOwn);
  const leaveThread = () => thread?.open(undefined);
  // Still paging back to the linked root (or reading the first window).
  const threadLoading =
    !openThread &&
    !room.history.isError &&
    (room.history.isPending ||
      room.history.isFetchingNextPage ||
      awaitingThreadRoot);
  const faces = (
    <span className="project-room__faces" aria-hidden="true">
      {participants.slice(0, 3).map((actor) => (
        <RoomAvatar
          key={actor.id}
          name={actor.displayName}
          agent={actor.kind === 'agent'}
        />
      ))}
    </span>
  );
  return (
    <section
      ref={section}
      className={`project-room project-room--${variant}${compact ? ' project-room--compact' : ''}${phone ? ' project-room--screen' : ''}`}
      aria-label="Project room"
    >
      {phone ? (
        <header className="project-room__header project-room__header--screen">
          {channelHeader(
            screenBar({
              ...(threadRoot
                ? {
                    backLabel: `Back to #${channelName}`,
                    onBack: leaveThread,
                    heading: { title: 'Thread', subtitle: `#${channelName}` },
                  }
                : {}),
              trailing: participants.length ? faces : undefined,
              actions: [
                tab === 'conversation'
                  ? {
                      key: 'notes',
                      label: 'Shared notes',
                      onSelect: () => guard(() => setTab('notes')),
                    }
                  : {
                      key: 'conversation',
                      label: 'Conversation',
                      onSelect: () => guard(() => setTab('conversation')),
                    },
              ],
            }),
          )}
        </header>
      ) : (
        <header className="project-room__header">
          {channelHeader()}
          <div
            className="project-room__presence"
            role="status"
            aria-label="People here"
          >
            {participants.length ? (
              <>
                {faces}
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
            <Button size="sm" onClick={() => onOpenRoom(channelId)}>
              Open room
            </Button>
          )}
        </header>
      )}
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
          {threadRoot && !phone && (
            <div className="project-room__thread-bar">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Back to #${channelName}`}
                onClick={leaveThread}
              >
                <ArrowLeftGlyph /> #{channelName}
              </Button>
              <h4 className="project-room__thread-title">Thread</h4>
            </div>
          )}
          {threadRoot ? (
            <RoomConversation
              key={`thread:${threadRoot}`}
              label="Thread"
              regionLabel="Messages in this thread"
              className="project-room__conversation"
              rows={threadRows}
              loading={threadLoading}
              status={
                openThread ? undefined : room.history.isError ? (
                  <ErrorState
                    variant="compact"
                    title="This thread could not be loaded."
                    action={
                      <Button
                        onClick={() =>
                          void (room.history.isFetchNextPageError
                            ? room.history.fetchNextPage()
                            : room.history.refetch())
                        }
                      >
                        Retry
                      </Button>
                    }
                  />
                ) : threadLoading ? (
                  <SkeletonBlock count={2} label="Loading thread" />
                ) : undefined
              }
              empty={
                room.history.isError ? undefined : (
                  <Empty
                    variant="compact"
                    label={
                      threadBeyondWindow
                        ? 'This thread is too far back to open here.'
                        : `This message is not in #${channelName}.`
                    }
                    action={
                      <Button onClick={leaveThread}>
                        Back to #{channelName}
                      </Button>
                    }
                  />
                )
              }
            />
          ) : (
            <RoomConversation
              label="Conversation"
              regionLabel={`Messages in #${channelName}`}
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
                    label={
                      archived
                        ? 'No messages were posted here.'
                        : 'Start a chat with your project team.'
                    }
                  />
                )
              }
              hasOlder={olderLoadable}
              olderNote={olderNote}
              loadingOlder={room.history.isFetchingNextPage}
              onLoadOlder={() => {
                // The notice stays until earlier messages actually load.
                void room.history.fetchNextPage().then((result) => {
                  if (!result.isError) acknowledgeUnloaded();
                });
              }}
            />
          )}
          {threadRoot && !openThread ? null : view.capabilities.discuss ? (
            <ProjectRoomComposer
              id={`message-${editorId}`}
              view={view}
              slug={slug}
              projectId={projectId}
              requestScope={requestScope}
              channelId={channelId}
              channelName={channelName}
              storageKey={storageKey}
              text={text}
              setText={setText}
              replyTo={replyTarget}
              replyAuthor={replyTarget ? authorOf(replyTarget) : undefined}
              setReplyTo={setReplyTo}
              draft={draft}
              clearDraftIfCurrent={clearDraftIfCurrent}
              recipient={recipient}
              setRecipient={setRecipient}
              participants={participants}
              // Hold sends until a legacy draft's migrated revision has
              // rendered, so an immediate Enter submits the revised draft.
              restored={restored && !unrevised}
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
              thread={!!openThread}
              files={canAct ? files : undefined}
              editing={canAct ? editing : undefined}
              editPending={room.edit.isPending}
              setEditText={(value) =>
                setEditing((current) =>
                  current ? { ...current, text: value } : current,
                )
              }
              cancelEdit={() => setEditing(undefined)}
              saveEdit={() => void saveEdit()}
              editLast={
                canAct && lastOwnMessage
                  ? () => startEdit(lastOwnMessage)
                  : undefined
              }
            />
          ) : (
            <p className="project-room__notice">
              {archived
                ? 'This channel is read-only.'
                : 'You can read this conversation.'}
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
      {picker && (
        <RoomEmojiPicker
          anchorRef={popoverAnchor}
          onClose={() => setPicker(undefined)}
          onPick={(emoji) => {
            const messageId = picker;
            setPicker(undefined);
            const reacted = messages
              .find((message) => message.messageId === messageId)
              ?.reactions?.find((reaction) => reaction.emoji === emoji)
              ?.actors.some((actor) => actor.id === me.id);
            // Picking an emoji you already used takes it back, as a tap would.
            react(messageId, emoji, !reacted);
          }}
        />
      )}
      {reactionsFor &&
        (() => {
          const message = messages.find(
            (item) => item.messageId === reactionsFor,
          );
          return message?.reactions?.length ? (
            <RoomReactionsSheet
              reactions={reactionViews(message)}
              anchorRef={popoverAnchor}
              onClose={() => setReactionsFor(undefined)}
            />
          ) : null;
        })()}
      <ConfirmModal
        isOpen={!!deleting}
        title="Delete this message?"
        message="Everyone in the channel sees “Message deleted” in its place."
        confirmLabel="Delete"
        variant="danger"
        pending={room.remove.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(undefined)}
      />
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
  channelId,
  channelName,
  storageKey,
  text,
  setText,
  replyTo,
  replyAuthor,
  setReplyTo,
  draft,
  clearDraftIfCurrent,
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
  thread = false,
  files,
  editing,
  editPending,
  setEditText,
  cancelEdit,
  saveEdit,
  editLast,
}: {
  id: string;
  view: ProjectRoomBrowserView;
  slug: string;
  projectId: string;
  requestScope: ApiRequestScope;
  /** The channel this composer posts and asks in; absent is `#general`. */
  channelId: string | undefined;
  channelName: string;
  storageKey: string;
  text: string;
  setText(value: Update<string>): void;
  replyTo?: string;
  replyAuthor?: string;
  setReplyTo(value: Update<string | undefined>): void;
  draft: ProjectRoomDraft;
  clearDraftIfCurrent(revision: ProjectRoomDraft): void;
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
  /** Replies go to the open thread (#4795): `replyTo` is its root. */
  thread?: boolean;
  /** The composer's files, when the host stores them (#4812). */
  files?: ReturnType<typeof useRoomAttachments>;
  /** The reader's own message being edited in place of a new one (#4797). */
  editing?: ProjectRoomEdit;
  editPending: boolean;
  setEditText(value: string): void;
  cancelEdit(): void;
  saveEdit(): void;
  /** Up in an empty composer edits the reader's last message. */
  editLast?(): void;
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
    channelId,
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
    } else if (current.name !== recipient.name)
      // A renamed Agent keeps its identity; show its current name (#4810 delta 3).
      setRecipient({ id: recipient.id, name: current.name });
  }, [recipient, agents, catalog.isSuccess, catalog.data, setRecipient]);
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const agentPanel = useRef<{
    ask(agentId: string, revision: ProjectRoomDraft): void;
  }>(null);
  // The Agent whose request is not settled yet. While there is one, Ask is
  // disabled rather than refused on press (#4810 round 2).
  const [pendingAgent, setPendingAgent] = useState<string>();
  const pendingName = pendingAgent
    ? (catalog.data?.agents.find((agent) => agent.slug === pendingAgent)
        ?.name ?? pendingAgent)
    : undefined;
  const waiting = !!recipient && !!pendingAgent;
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
    enabled: !blocked && !recipient && !editing,
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
  const value = editing ? editing.text : text;
  const tooLong =
    new TextEncoder().encode(value).length > PROJECT_ROOM_LIMITS.textBytes;
  const hasFiles = !!files?.files.length;
  // Saving an edit needs a change; an unchanged text has nothing to save.
  const canSend = editing
    ? !editPending &&
      editing.text !== editing.original &&
      (!!editing.text.trim() || editing.hasFiles) &&
      !tooLong
    : restored &&
      !blocked &&
      (!!text.trim() || (hasFiles && !recipient)) &&
      !files?.busy &&
      !tooLong &&
      !waiting;
  return (
    <>
      {agents && view.capabilities.discuss && (
        <ProjectRoomAgentPanel
          key={`${view.roomId}:${view.actor.id}`}
          requestScope={requestScope}
          slug={slug}
          projectId={projectId}
          channelId={channelId}
          roomId={view.roomId}
          actorId={view.actor.id}
          storageKey={`${storageKey}:agent`}
          prompt={text}
          checkpointSeq={view.checkpoint.lastSeq}
          replyTo={replyTo}
          blocked={!restored || blocked || !!editing}
          toolsSlot={toolsSlot}
          askRef={agentPanel}
          onPendingChange={setPendingAgent}
          onAsked={clearDraftIfCurrent}
          prepareRecap={prepareRecap}
          refresh={refresh}
          inThread={thread}
        />
      )}
      <RoomComposer
        id={id}
        label={thread ? 'Reply in thread' : 'Message the project'}
        placeholder={thread ? 'Reply in thread' : `Message #${channelName}`}
        value={value}
        onValueChange={(next, caret) => {
          if (editing) {
            setEditText(next);
            return;
          }
          setText(next);
          setRecipientNotice('');
          mention.find(next, caret);
        }}
        onSend={() => {
          if (editing) saveEdit();
          else if (recipient) {
            // The revision travels with the accepted request; nothing is
            // recorded for an attempt the panel refuses.
            if (!waiting) agentPanel.current?.ask(recipient.id, draft);
          } else send();
        }}
        canSend={canSend}
        pending={editing ? editPending : sending}
        sendLabel={
          editing
            ? 'Save edit'
            : waiting
              ? `Waiting for ${pendingName}…`
              : recipient
                ? `Ask ${recipient.name}`
                : 'Send message'
        }
        textareaRef={composer}
        sendGlyph={editing ? <CheckGlyph /> : undefined}
        attachments={
          files
            ? {
                port: files,
                // Files go with a new message; an edit changes text only, and
                // an Agent request carries none.
                locked: blocked || !!editing || !!recipient,
                owner: view.roomId,
              }
            : undefined
        }
        inputProps={{
          'aria-controls': mention.open ? `${id}-mentions` : undefined,
          'aria-activedescendant':
            mention.open && mention.filtered.length
              ? `${id}-mentions-option-${mention.selected}`
              : undefined,
          'aria-describedby': `${id}-help`,
          onKeyDown: (event) => {
            mention.onKeyDown(event);
            if (event.defaultPrevented) return;
            const plain =
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey;
            if (event.key === 'Escape' && editing) {
              event.preventDefault();
              cancelEdit();
            } else if (
              event.key === 'ArrowUp' &&
              plain &&
              !editing &&
              !text &&
              !hasFiles &&
              editLast
            ) {
              // #4793 deferred this: Up in an empty composer edits your last message.
              event.preventDefault();
              editLast();
            }
          },
          onClick: (event) =>
            mention.find(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            ),
        }}
        above={
          editing ? (
            <span className="room-composer__chip">
              <EditGlyph /> Editing message
              <Button variant="ghost" size="sm" onClick={cancelEdit}>
                Cancel
              </Button>
            </span>
          ) : (replyTo && !thread) || recipient ? (
            <>
              {replyTo && !thread && (
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
              disabled={blocked || !!recipient || !!editing}
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
              {editing
                ? 'Enter to save, Escape to cancel the edit.'
                : 'Enter to send, Shift+Enter for a new line. Type @ to mention a person or agent.'}
            </p>
            {waiting && (
              <p className="room-composer__status" role="status">
                Waiting for {pendingName}…
              </p>
            )}
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
  channelId,
  roomId,
  actorId,
  storageKey,
  prompt,
  checkpointSeq,
  replyTo,
  inThread = false,
  blocked,
  prepareRecap,
  refresh,
  toolsSlot,
  askRef,
  onAsked,
  onPendingChange,
}: {
  requestScope: ApiRequestScope;
  slug: string;
  projectId: string;
  /** The channel the request lives in; absent is `#general`. */
  channelId: string | undefined;
  roomId: string;
  actorId: string;
  storageKey: string;
  prompt: string;
  checkpointSeq: number;
  replyTo?: string;
  /** A thread's replies have nothing to recap (#4795). */
  inThread?: boolean;
  blocked: boolean;
  prepareRecap(): void;
  refresh(): void;
  /** The composer's tool bar: Recap and Bring an Agent render there. */
  toolsSlot: HTMLElement | null;
  /** Lets an @agent pick in the composer ask through this same request path. */
  askRef: Ref<{ ask(agentId: string, revision: ProjectRoomDraft): void }>;
  /** An @agent request was acknowledged for the draft revision it was asked from. */
  onAsked(revision: ProjectRoomDraft): void;
  /** The Agent whose request is in flight or retained and unsettled. */
  onPendingChange(agentId: string | undefined): void;
}) {
  const guard = {
    expectedRoomId: roomId,
    expectedProjectId: projectId,
    expectedActorId: actorId,
  };
  const [open, setOpen] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
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
  const agent = useProjectRoomAgent(
    requestScope,
    slug,
    guard,
    !stopped,
    channelId,
  );
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
    mentioned?: { agentId: string; revision: ProjectRoomDraft },
  ) {
    if (!ready || stopped || busy.current) return;
    let saved = retained;
    const chosen = mentioned?.agentId ?? agentId;
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
      // `mentioned` belongs to this accepted call only; a refused call
      // returned above without recording anything.
      if (mentioned) onAsked(mentioned.revision);
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
    ask: (mentionedAgent: string, revision: ProjectRoomDraft) =>
      void requestAction.current('request', {
        agentId: mentionedAgent,
        revision,
      }),
  }));
  const pendingAgent =
    (retained && !terminal) || agent.request.isPending
      ? retained?.intent.agentId
      : undefined;
  useEffect(() => {
    onPendingChange(pendingAgent);
  }, [pendingAgent, onPendingChange]);
  useEffect(() => () => onPendingChange(undefined), [onPendingChange]);
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
      {!inThread && (
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
      )}
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
            ) : !retained.requestId ? (
              // Without a handle there is nothing to inspect or cancel; the
              // reader can still let it go (#4810 delta 2).
              <Button
                disabled={agent.request.isPending}
                onClick={() => setConfirmAbandon(true)}
              >
                Abandon this request
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
      <ConfirmModal
        isOpen={confirmAbandon && !!retained && !retained.requestId}
        title="Stop tracking this request?"
        message="It may still be running, and you won’t be able to retry it from here."
        confirmLabel="Stop tracking"
        variant="warning"
        onCancel={() => setConfirmAbandon(false)}
        onConfirm={() => {
          setConfirmAbandon(false);
          sessionStorage.removeItem(storageKey);
          setRetained(undefined);
          setHandle(undefined);
          setNotice(
            'Request abandoned. It may already have run; check the room before asking again.',
          );
        }}
      />
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
