import type {
  ProjectMemberAction,
  ProjectMembershipScope,
} from '@kontourai/station-contracts/project-membership';
import type {
  ProjectRoomActor,
  ProjectRoomAppendInput,
  ProjectRoomChannelCreateInput,
  ProjectRoomChannelUpdateInput,
  ProjectRoomNoteInput,
  ProjectRoomView,
} from '@kontourai/station-contracts/project-room';
import type {
  ProjectRoomBrowserView,
  ProjectRoomPresence,
} from '@kontourai/station-contracts/project-room-browser';
import { ProjectRoomRefusal, ProjectRoomStore } from './project-room-store.js';
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
  constructor(
    private readonly store: ProjectRoomStore,
    readonly access: ProjectRoomAccessPort,
  ) {}
  // One consistency read per active Room, independent of subscriber count.
  // Other SQLite connections/processes do not share the in-process commit owner.
  private rooms = new Map<
    string,
    {
      listeners: Set<() => void>;
      off: () => void;
      timer: ReturnType<typeof setInterval>;
      value: ReturnType<ProjectRoomStore['checkpoint']> | undefined;
    }
  >();
  watch(roomId: string, callback: () => void) {
    this.assertOpen();
    let room = this.rooms.get(roomId);
    if (!room) {
      const listeners = new Set<() => void>();
      const refresh = () => {
        const current = this.rooms.get(roomId);
        if (!current) return;
        try {
          const value = this.store.checkpoint(roomId);
          if (JSON.stringify(value) === JSON.stringify(current.value)) return;
          current.value = value;
        } catch {
          current.value = undefined;
          // Wake consumers to fail closed on the next checkpoint read.
        }
        for (const listener of listeners) listener();
      };
      room = {
        listeners,
        value: this.store.checkpoint(roomId),
        off: this.store.subscribe(roomId, refresh),
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
    for (const [key, p] of this.participants)
      if (Date.parse(p.value.expiresAt) <= now) {
        this.participants.delete(key);
        this.notifyPresence(p.roomId);
      }
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
    return this.run(
      request,
      slug,
      'discuss',
      guard,
      (scope, actor, _caps, assertCurrent) =>
        this.store.append(scope, actor, input, assertCurrent, channelId),
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
