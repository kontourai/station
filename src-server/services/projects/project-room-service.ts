import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type {
  ProjectMemberAction,
  ProjectMembershipScope,
} from '@kontourai/station-contracts/project-membership';
import type {
  ProjectRoomActor,
  ProjectRoomAppendInput,
  ProjectRoomAttachment,
  ProjectRoomChannelCreateInput,
  ProjectRoomChannelUpdateInput,
  ProjectRoomDeleteInput,
  ProjectRoomEditInput,
  ProjectRoomMention,
  ProjectRoomMessage,
  ProjectRoomNoteInput,
  ProjectRoomReactionInput,
  ProjectRoomView,
} from '@kontourai/station-contracts/project-room';
import {
  PROJECT_ROOM_TYPING_TTL_MS,
  type ProjectRoomBrowserView,
  type ProjectRoomPresence,
} from '@kontourai/station-contracts/project-room-browser';
import { createLogger } from '../../utils/logger.js';
import { ProjectRoomRefusal, ProjectRoomStore } from './project-room-store.js';
import {
  ProjectRoomFilesUnavailable,
  type ReclaimOutcome,
} from './task-room-attachments.js';

const logger = createLogger({ name: 'project-room-service' });
/**
 * How long an upload no message names is kept for its send (#4812). A send
 * that fails or is discarded leaves it behind; after this it is released.
 */
const PROJECT_ROOM_UNSENT_FILE_TTL_MS = 24 * 60 * 60 * 1000;
export type ProjectRoomCapabilities = ProjectRoomView['capabilities'];
export interface ProjectRoomAccessPort {
  withAction<T>(
    request: Request,
    slug: string,
    action: ProjectMemberAction,
    expectedActorId: string | undefined,
    operation: (
      scope: ProjectMembershipScope,
      actor: ProjectRoomActor,
      capabilities: ProjectRoomCapabilities,
      assertCurrentSync: () => void,
    ) => T,
  ): Promise<T>;
  current(
    request: Request,
    scope: ProjectMembershipScope,
    actorId: string,
    action: ProjectMemberAction,
  ): Promise<boolean>;
  /**
   * The people who may read this Project's rooms, with current names
   * (#4799): who a message may mention. Called inside an admitted operation.
   * Absent means only the caller.
   */
  members?(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
  ): ProjectRoomActor[];
}
/** A committed message that names people (#4799), for their notifications. */
export interface ProjectRoomMentionEvent {
  scope: ProjectMembershipScope;
  slug: string;
  /** Absent for the Project's default room. */
  channelId?: string;
  message: ProjectRoomMessage;
  /** The channel's name, when the room is a named channel. */
  channelName?: string;
  /** People newly named: never the author, each once. */
  recipients: string[];
}
export interface ProjectRoomMutationGuard {
  expectedRoomId: string;
  expectedProjectId: string;
  expectedActorId: string;
}
/** Guards a channel operation: the Project and actor the client saw. */
export type ProjectRoomChannelGuard = Omit<
  ProjectRoomMutationGuard,
  'expectedRoomId'
>;
export interface ProjectRoomAdmission {
  scope: ProjectMembershipScope;
  actorId: string;
}
/** Byte storage for room files (`ProjectRoomAttachments`), keyed by a binding tuple. */
export interface ProjectRoomAttachmentPort {
  /**
   * Runs `operation` under the store's cross-process lock. `store`, `release`
   * and `sweep` are called only inside it, and so is any message write that
   * names files (`ProjectRoomAttachments.locked`).
   */
  locked<T>(operation: () => Promise<T>): Promise<T>;
  store(
    binding: readonly string[],
    inputs: ChatAttachmentInput[],
  ): ProjectRoomAttachment[];
  read(
    binding: readonly string[],
    id: string,
  ): { attachment: ProjectRoomAttachment; bytes: Buffer } | undefined;
  resolve(
    binding: readonly string[],
    attachments: ProjectRoomAttachment[],
  ): unknown;
  /**
   * Gives up these files, and deletes bytes no other file names; `blocked`
   * when the store could not prove its references and nothing changed.
   */
  release(binding: readonly string[], ids: readonly string[]): ReclaimOutcome;
  /** Releases files no standing message needs (`ProjectRoomAttachments.sweep`). */
  sweep(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ): ReclaimOutcome;
}
/**
 * A file belongs to the person who uploaded it, in one room of one Project
 * incarnation. A message can name only its author's own uploads, and a read
 * resolves through the author of the message that carries the file.
 */
const liveKey = (actorId: string, clientId: string) =>
  JSON.stringify([actorId, clientId]);
const attachmentBinding = (
  scope: ProjectMembershipScope,
  roomId: string,
  uploader: ProjectRoomActor,
) => [
  scope.stationId,
  scope.localProjectId,
  scope.portableProjectId,
  roomId,
  uploader.kind,
  uploader.id,
];
export class ProjectRoomService {
  private closed = false;
  private participants = new Map<
    string,
    {
      roomId: string;
      scope: ProjectMembershipScope;
      value: ProjectRoomPresence;
    }
  >();
  private subscriptions = new Set<() => void>();
  /** Who is typing where (#4798): self-expiring, and cleared with its stream. */
  private typists = new Map<
    string,
    { roomId: string; actor: ProjectRoomActor; expiresAt: number }
  >();
  /** Clients with an open live stream, by actor: their presence does not lapse. */
  private liveClients = new Map<string, number>();
  constructor(
    private readonly store: ProjectRoomStore,
    readonly access: ProjectRoomAccessPort,
    private readonly attachments?: ProjectRoomAttachmentPort,
    private readonly onMention?: (event: ProjectRoomMentionEvent) => void,
  ) {}
  /**
   * Runs a whole admitted operation under the file store's lock: the lock is
   * taken first and the operation's authority check runs inside it, so access
   * revoked while waiting refuses before anything is written.
   */
  private async underFileLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.attachments) return operation();
    try {
      return await this.attachments.locked(operation);
    } catch (error) {
      // The store could not even be opened for writing (its root or lock
      // file): the files are unavailable, not the room (#4852 review).
      if (error instanceof ProjectRoomFilesUnavailable)
        throw new ProjectRoomRefusal('files_unavailable');
      throw error;
    }
  }
  /**
   * Refused input (a validation, the per-room cap) is invalid; a store that
   * cannot prove its references or could not write is unavailable.
   */
  private files<T>(run: (port: ProjectRoomAttachmentPort) => T): T {
    if (!this.attachments) throw new ProjectRoomRefusal('not_found');
    try {
      return run(this.attachments);
    } catch (error) {
      // A store that cannot prove its references, or whose write failed,
      // takes no new files; any other byte-store failure is the caller's
      // input.
      if (error instanceof ProjectRoomFilesUnavailable)
        throw new ProjectRoomRefusal('files_unavailable');
      throw new ProjectRoomRefusal('invalid');
    }
  }
  // One consistency read per active Room, independent of subscriber count.
  // Other SQLite connections/processes do not share the in-process commit owner.
  private rooms = new Map<
    string,
    {
      listeners: Set<(changed?: readonly string[]) => void>;
      off: () => void;
      timer: ReturnType<typeof setInterval>;
      value: ReturnType<ProjectRoomStore['checkpoint']> | undefined;
    }
  >();
  /**
   * Wakes `callback` when the room changes. A commit in this process passes
   * the messages whose reactions, edit or delete it wrote (#4798), and wakes
   * even when the checkpoint is unchanged (an Agent request moved); a change
   * seen only by the periodic consistency read passes nothing.
   */
  watch(roomId: string, callback: (changed?: readonly string[]) => void) {
    this.assertOpen();
    let room = this.rooms.get(roomId);
    if (!room) {
      const listeners = new Set<(changed?: readonly string[]) => void>();
      const read = () => {
        const current = this.rooms.get(roomId);
        if (!current) return false;
        try {
          const value = this.store.checkpoint(roomId);
          if (JSON.stringify(value) === JSON.stringify(current.value))
            return false;
          current.value = value;
        } catch {
          current.value = undefined;
          // Wake consumers to fail closed on the next checkpoint read.
        }
        return true;
      };
      const refresh = () => {
        if (!read()) return;
        for (const listener of listeners) listener();
      };
      const committed = (changed: readonly string[]) => {
        if (!this.rooms.has(roomId)) return;
        read();
        for (const listener of listeners) listener(changed);
      };
      room = {
        listeners,
        value: this.store.checkpoint(roomId),
        off: this.store.subscribe(roomId, committed),
        timer: setInterval(refresh, 20000),
      };
      this.rooms.set(roomId, room);
    } else {
      // Reconnect establishes a fresh durable checkpoint even when another
      // connection wrote since this Room's last consistency check.
      const value = this.store.checkpoint(roomId);
      if (JSON.stringify(value) !== JSON.stringify(room.value)) {
        room.value = value;
        for (const listener of room.listeners) listener();
      }
    }
    room.listeners.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      room.listeners.delete(callback);
      if (!room.listeners.size) {
        room.off();
        clearInterval(room.timer);
        this.rooms.delete(roomId);
      }
    };
  }
  checkpoint(roomId: string) {
    return this.rooms.get(roomId)?.value ?? this.store.checkpoint(roomId);
  }
  private assertOpen() {
    if (this.closed) throw new ProjectRoomRefusal('not_found');
  }
  private notifyPresence(roomId: string) {
    for (const listener of this.rooms.get(roomId)?.listeners ?? []) listener();
  }
  private prune() {
    const now = Date.now();
    for (const [key, p] of this.participants) {
      // A client whose live stream is open stays present without renewing.
      if (this.liveClients.has(liveKey(p.value.actor.id, p.value.clientId))) {
        if (Date.parse(p.value.expiresAt) - now < 15000)
          p.value.expiresAt = new Date(now + 30000).toISOString();
        continue;
      }
      if (Date.parse(p.value.expiresAt) <= now) {
        this.participants.delete(key);
        this.notifyPresence(p.roomId);
      }
    }
    for (const [key, t] of this.typists)
      if (t.expiresAt <= now) {
        this.typists.delete(key);
        this.notifyPresence(t.roomId);
      }
  }
  /** People typing in `roomId` now, each once, in the order they started. */
  typing(roomId: string): ProjectRoomActor[] {
    this.prune();
    const seen = new Map<string, ProjectRoomActor>();
    for (const t of this.typists.values())
      if (t.roomId === roomId && !seen.has(t.actor.id))
        seen.set(t.actor.id, { ...t.actor });
    return [...seen.values()];
  }
  /**
   * A live stream opened for this client (#4798). Its presence lasts while
   * the stream is open; closing the stream (the returned function) clears
   * that client's presence and typing at once.
   */
  openClient(actorId: string, clientId: string) {
    const key = liveKey(actorId, clientId);
    this.liveClients.set(key, (this.liveClients.get(key) ?? 0) + 1);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      const count = (this.liveClients.get(key) ?? 1) - 1;
      if (count > 0) {
        this.liveClients.set(key, count);
        return;
      }
      this.liveClients.delete(key);
      for (const [entry, p] of this.participants)
        if (p.value.actor.id === actorId && p.value.clientId === clientId) {
          this.participants.delete(entry);
          this.notifyPresence(p.roomId);
        }
      for (const [entry, t] of this.typists)
        if (entry.startsWith(`${key}\u0000`)) {
          this.typists.delete(entry);
          this.notifyPresence(t.roomId);
        }
    };
  }
  presence(roomId: string): ProjectRoomPresence[] {
    this.prune();
    return [...this.participants.values()]
      .filter((p) => p.roomId === roomId)
      .map((p) => structuredClone(p.value));
  }
  private async run<T>(
    request: Request,
    slug: string,
    action: ProjectMemberAction,
    guard: ProjectRoomMutationGuard | ProjectRoomChannelGuard | undefined,
    operation: (
      scope: ProjectMembershipScope,
      actor: ProjectRoomActor,
      caps: ProjectRoomCapabilities,
      assertCurrent: () => void,
    ) => T,
    channelId?: string,
  ) {
    this.assertOpen();
    const outcome = await this.access.withAction(
      request,
      slug,
      action,
      guard?.expectedActorId,
      (scope, actor, caps, assertCurrent) => {
        try {
          this.assertOpen();
          if (
            guard &&
            (actor.id !== guard.expectedActorId ||
              scope.localProjectId !== guard.expectedProjectId ||
              ('expectedRoomId' in guard &&
                this.store.lookupRoom(scope, channelId)?.roomId !==
                  guard.expectedRoomId))
          )
            throw new ProjectRoomRefusal('conflict');
          const result = operation(scope, actor, caps, () => {
            this.assertOpen();
            const result: unknown = assertCurrent();
            if (result !== undefined) throw new ProjectRoomRefusal('invalid');
          });
          return {
            ok: true as const,
            data: result,
            admission: { scope: structuredClone(scope), actorId: actor.id },
          };
        } catch (error) {
          if (error instanceof ProjectRoomRefusal)
            return { ok: false as const, error };
          throw error;
        }
      },
    );
    if (!outcome.ok) throw outcome.error;
    return { data: outcome.data, admission: outcome.admission };
  }
  open(request: Request, slug: string, expectedProjectId?: string) {
    return this.run(
      request,
      slug,
      'discuss',
      undefined,
      (scope, _actor, _caps, assertCurrent) => {
        if (
          expectedProjectId !== undefined &&
          scope.localProjectId !== expectedProjectId
        )
          throw new ProjectRoomRefusal('conflict');
        return this.store.ensureRoom(scope, assertCurrent);
      },
    );
  }
  discover(request: Request, slug: string, channelId?: string) {
    return this.run(
      request,
      slug,
      'view',
      undefined,
      (scope, actor, capabilities, assertCurrent): ProjectRoomBrowserView => {
        const room = this.store.lookupRoom(scope, channelId);
        if (!room) throw new ProjectRoomRefusal('not_found');
        const checkpoint = this.store.history(
          scope,
          0,
          1,
          channelId,
        ).checkpoint;
        const note = this.store.getNote(scope, channelId);
        assertCurrent();
        return {
          ...room,
          checkpoint,
          note,
          actor: { ...actor },
          capabilities: { ...capabilities },
          presence: this.presence(room.roomId),
        };
      },
      channelId,
    );
  }
  history(
    request: Request,
    slug: string,
    after: number,
    limit: number,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'view',
      undefined,
      (scope, _actor, _caps, assertCurrent) => {
        const result = this.store.history(scope, after, limit, channelId);
        assertCurrent();
        return result;
      },
      channelId,
    );
  }
  append(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    input: ProjectRoomAppendInput,
    channelId?: string,
  ) {
    // A message naming files is linked under the file lock, so no sweep in
    // another process can release a file between this check and the link.
    if (!input.attachments?.length)
      return this.appendAdmitted(request, slug, guard, input, channelId);
    return this.underFileLock(() =>
      this.appendAdmitted(request, slug, guard, input, channelId),
    );
  }
  private appendAdmitted(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    input: ProjectRoomAppendInput,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'discuss',
      guard,
      (scope, actor, _caps, assertCurrent) => {
        // An exact retry of a committed send is acknowledged first, as the
        // message now stands: its files may since have been released, and a
        // replay links nothing (#4852 review).
        if (input.attachments?.length) {
          const replay = this.store.sendReceipt(
            scope,
            actor,
            input,
            assertCurrent,
            channelId,
          );
          if (replay) return replay;
        }
        // Every file must be the sender's own upload to this room, unchanged.
        if (input.attachments?.length) {
          const roomId = this.store.lookupRoom(scope, channelId)?.roomId;
          if (!roomId) throw new ProjectRoomRefusal('not_found');
          this.files((port) =>
            port.resolve(
              attachmentBinding(scope, roomId, actor),
              input.attachments!,
            ),
          );
        }
        this.assertMentions(scope, actor, input.mentions);
        const message = this.store.append(
          scope,
          actor,
          input,
          assertCurrent,
          channelId,
        );
        return message;
      },
      channelId,
    ).then((result) => {
      this.announce(result.admission.scope, slug, channelId, result.data, []);
      return result;
    });
  }
  /** A message may name only people who can read this Project's rooms. */
  private assertMentions(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    mentions: readonly ProjectRoomMention[] | undefined,
  ) {
    if (!mentions?.length) return;
    const members = new Set(
      (this.access.members?.(scope, actor) ?? [actor]).map(
        (member) => member.id,
      ),
    );
    if (mentions.some((mention) => !members.has(mention.actorId)))
      throw new ProjectRoomRefusal('invalid');
  }
  /** Tells newly named people, once each, never the author (#4799). */
  private announce(
    scope: ProjectMembershipScope,
    slug: string,
    channelId: string | undefined,
    message: ProjectRoomMessage,
    before: readonly string[],
  ) {
    if (!this.onMention || !message.mentions?.length) return;
    const recipients = [
      ...new Set(message.mentions.map((mention) => mention.actorId)),
    ].filter((id) => id !== message.actor.id && !before.includes(id));
    if (!recipients.length) return;
    try {
      const channelName = this.store.channelName(scope, message.roomId);
      this.onMention({
        scope: structuredClone(scope),
        slug,
        ...(channelId === undefined ? {} : { channelId }),
        message: structuredClone(message),
        ...(channelName ? { channelName } : {}),
        recipients,
      });
    } catch (error) {
      // A notification is best effort; the message is already committed.
      logger.warn('Project room mention notification failed', { error });
    }
  }
  /**
   * The people a message here may mention (#4799), with current names: the
   * picker's list, and the names old mentions render with.
   */
  members(request: Request, slug: string, channelId?: string) {
    return this.run(
      request,
      slug,
      'view',
      undefined,
      (scope, actor, _caps, assertCurrent) => {
        if (!this.store.lookupRoom(scope, channelId))
          throw new ProjectRoomRefusal('not_found');
        // Public fields only, whatever the port returns: id, current name
        // and kind. People only; nothing else about a member leaves here.
        const members = (this.access.members?.(scope, actor) ?? [actor])
          .filter((member) => member.kind === 'person')
          .map((member) => ({
            id: member.id,
            displayName: member.displayName,
            kind: 'person' as const,
          }));
        assertCurrent();
        return { members };
      },
      channelId,
    );
  }
  /**
   * Whether an unread message after `after` names the caller (#4799), read
   * under the room's `view` admission, at most `limit` messages ahead.
   */
  mentioned(
    request: Request,
    slug: string,
    after: number,
    limit: number,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'view',
      undefined,
      (scope, actor, _caps, assertCurrent) => {
        const room = this.store.lookupRoom(scope, channelId);
        if (!room) throw new ProjectRoomRefusal('not_found');
        const mentioned = this.store.mentionedAfter(
          room.roomId,
          after,
          actor.id,
          limit,
        );
        assertCurrent();
        return mentioned;
      },
      channelId,
    );
  }
  /** Admitted-room reads for the live stream: deltas and Agent activity. */
  projectedMessages(roomId: string, messageIds: readonly string[]) {
    return this.store.projectedMessages(roomId, messageIds);
  }
  recentRequests(
    roomId: string,
    limit: number,
    working: number,
    failed: (requestIds: readonly string[]) => { has(id: string): boolean },
  ) {
    return this.store.recentRequests(roomId, limit, working, failed);
  }
  /** Starts or stops the caller's typing signal in a room (#4798). */
  updateTyping(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    clientId: string,
    typing: boolean,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'discuss',
      guard,
      (_scope, actor, _caps, assertCurrent) => {
        this.prune();
        const key = `${liveKey(actor.id, clientId)}\u0000${guard.expectedRoomId}`;
        if (typing && !this.typists.has(key) && this.typists.size >= 1000)
          throw new ProjectRoomRefusal('capacity');
        assertCurrent();
        if (typing)
          this.typists.set(key, {
            roomId: guard.expectedRoomId,
            actor: { ...actor },
            expiresAt: Date.now() + PROJECT_ROOM_TYPING_TTL_MS,
          });
        else this.typists.delete(key);
        this.notifyPresence(guard.expectedRoomId);
        return { typing };
      },
      channelId,
    );
  }
  react(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    messageId: string,
    input: ProjectRoomReactionInput,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'discuss',
      guard,
      (scope, actor, _caps, assertCurrent) =>
        this.store.react(
          scope,
          actor,
          messageId,
          input,
          assertCurrent,
          channelId,
        ),
      channelId,
    );
  }
  edit(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    messageId: string,
    input: ProjectRoomEditInput,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'discuss',
      guard,
      (scope, actor, _caps, assertCurrent) => {
        this.assertMentions(scope, actor, input.mentions);
        const roomId = this.store.lookupRoom(scope, channelId)?.roomId;
        const before = roomId
          ? (this.store
              .projectedMessages(roomId, [messageId])[0]
              ?.mentions?.map((mention) => mention.actorId) ?? [])
          : [];
        return {
          before,
          message: this.store.edit(
            scope,
            actor,
            messageId,
            input,
            assertCurrent,
            channelId,
          ),
        };
      },
      channelId,
    ).then(({ data, admission }) => {
      // Only people the edit newly names are told.
      this.announce(
        admission.scope,
        slug,
        channelId,
        data.message,
        data.before,
      );
      return { data: data.message, admission };
    });
  }
  deleteMessage(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    messageId: string,
    input: ProjectRoomDeleteInput,
    channelId?: string,
  ) {
    return this.underFileLock(() =>
      this.run(
        request,
        slug,
        'discuss',
        guard,
        (scope, actor, _caps, assertCurrent) => {
          const deleted = this.store.deleteMessage(
            scope,
            actor,
            messageId,
            input,
            assertCurrent,
            channelId,
          );
          // The tombstone already withholds the files; their place in the
          // uploader's quota goes with them. A failure here is logged, and the
          // next upload's sweep releases them instead.
          if (this.attachments) {
            const files = this.store.messageFiles(scope, messageId, channelId);
            if (files.ids.length)
              try {
                const outcome = this.attachments.release(
                  attachmentBinding(scope, files.roomId, files.author),
                  files.ids,
                );
                if (outcome === 'blocked')
                  logger.warn(
                    'Project room file records could not be read; nothing was reclaimed and new attachments are refused',
                  );
                else if (outcome === 'kept')
                  logger.warn(
                    'Project room file bytes could not be deleted; their records are kept for a later retry',
                  );
              } catch (error) {
                logger.warn(
                  'Project room files of a deleted message were kept',
                  {
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              }
          }
          return deleted;
        },
        channelId,
      ),
    );
  }
  /** Stores files for a message the caller is about to send in this room. */
  storeAttachments(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    inputs: ChatAttachmentInput[],
    channelId?: string,
  ) {
    return this.underFileLock(() =>
      this.run(
        request,
        slug,
        'discuss',
        guard,
        (scope, actor, _caps, assertCurrent) => {
          const roomId = this.store.writableRoomId(scope, channelId);
          assertCurrent();
          const binding = attachmentBinding(scope, roomId, actor);
          // Before counting the quota, release what no standing message needs:
          // a deleted message's files and old unsent uploads.
          if (this.attachments)
            try {
              const outcome = this.attachments.sweep(
                binding,
                Date.now() - PROJECT_ROOM_UNSENT_FILE_TTL_MS,
                (ids) => this.store.attachmentLinks(roomId, ids),
              );
              if (outcome === 'blocked')
                logger.warn(
                  'Project room file records could not be read; nothing was reclaimed and new attachments are refused',
                );
              else if (outcome === 'kept')
                logger.warn(
                  'Project room file bytes could not be deleted; their records are kept for a later retry',
                );
            } catch (error) {
              logger.warn('Project room upload sweep did not finish', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          return this.files((port) => port.store(binding, inputs));
        },
        channelId,
      ),
    );
  }
  /** A file of a readable message in this room; anything else is not found. */
  readAttachment(
    request: Request,
    slug: string,
    attachmentId: string,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'view',
      undefined,
      (scope, _actor, _caps, assertCurrent) => {
        const owner = this.store.attachmentRoom(scope, attachmentId, channelId);
        const file = owner
          ? this.attachments?.read(
              attachmentBinding(scope, owner.roomId, owner.author),
              attachmentId,
            )
          : undefined;
        if (!file) throw new ProjectRoomRefusal('not_found');
        assertCurrent();
        return file;
      },
      channelId,
    );
  }
  note(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    input: ProjectRoomNoteInput,
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'edit',
      guard,
      (scope, actor, _caps, assertCurrent) =>
        this.store.updateNote(scope, actor, input, assertCurrent, channelId),
      channelId,
    );
  }
  channels(request: Request, slug: string) {
    return this.run(
      request,
      slug,
      'view',
      undefined,
      (scope, _actor, _caps, assertCurrent) => {
        const channels = this.store.listChannels(scope);
        assertCurrent();
        return { channels };
      },
    );
  }
  createChannel(
    request: Request,
    slug: string,
    guard: ProjectRoomChannelGuard,
    input: ProjectRoomChannelCreateInput,
  ) {
    return this.run(
      request,
      slug,
      'edit',
      guard,
      (scope, _actor, _caps, assertCurrent) =>
        this.store.createChannel(scope, input, assertCurrent),
    );
  }
  updateChannel(
    request: Request,
    slug: string,
    channelId: string,
    guard: ProjectRoomChannelGuard,
    input: ProjectRoomChannelUpdateInput,
  ) {
    return this.run(
      request,
      slug,
      'edit',
      guard,
      (scope, _actor, _caps, assertCurrent) =>
        this.store.updateChannel(scope, channelId, input, assertCurrent),
    );
  }
  updatePresence(
    request: Request,
    slug: string,
    guard: ProjectRoomMutationGuard,
    clientId: string,
    state: 'join' | 'leave',
    channelId?: string,
  ) {
    return this.run(
      request,
      slug,
      'view',
      guard,
      (scope, actor, _caps, assertCurrent) => {
        this.prune();
        const key = JSON.stringify([guard.expectedRoomId, actor.id, clientId]);
        if (
          state === 'join' &&
          !this.participants.has(key) &&
          (this.participants.size >= 1000 ||
            this.presence(guard.expectedRoomId).length >= 100)
        )
          throw new ProjectRoomRefusal('capacity');
        assertCurrent();
        if (state === 'leave') this.participants.delete(key);
        else
          this.participants.set(key, {
            roomId: guard.expectedRoomId,
            scope: { ...scope },
            value: {
              clientId,
              actor: { ...actor },
              expiresAt: new Date(Date.now() + 30000).toISOString(),
            },
          });
        this.notifyPresence(guard.expectedRoomId);
        return this.presence(guard.expectedRoomId);
      },
      channelId,
    );
  }
  async current(request: Request, admission: ProjectRoomAdmission) {
    try {
      const current =
        !this.closed &&
        (await this.access.current(
          request,
          admission.scope,
          admission.actorId,
          'view',
        ));
      if (!current) this.removePresence(admission);
      return current;
    } catch (error) {
      this.removePresence(admission);
      throw error;
    }
  }
  removePresence(admission: ProjectRoomAdmission) {
    for (const [key, p] of this.participants)
      if (
        p.value.actor.id === admission.actorId &&
        JSON.stringify(p.scope) === JSON.stringify(admission.scope)
      ) {
        this.participants.delete(key);
        this.notifyPresence(p.roomId);
      }
  }
  onClose(callback: () => void) {
    if (this.closed) callback();
    else this.subscriptions.add(callback);
    return () => {
      this.subscriptions.delete(callback);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.participants.clear();
    for (const room of this.rooms.values()) {
      room.off();
      clearInterval(room.timer);
    }
    this.rooms.clear();
    for (const stop of this.subscriptions) stop();
    this.subscriptions.clear();
  }
}
