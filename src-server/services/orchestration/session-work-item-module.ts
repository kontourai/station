import type { SessionWorkItemReadProjection } from '@kontourai/station-contracts/session-work-item';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { EventStore } from './event-store.js';
import { projectSessionWorkItemRead } from './work-item-result-projector.js';

export type SessionWorkItemReadOutcome =
  | { status: 'found'; projection: SessionWorkItemReadProjection }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/**
 * Authorized work-item read boundary.  It deliberately owns no routing or
 * runtime-tool wiring: composition supplies the current Session authority.
 */
export interface SessionWorkItemModule {
  read(input: {
    sessionId: string;
    conversationId: string;
    authority: SessionReadAuthority;
    /** Replays the current principal and hosted-tenant fence at publication. */
    current: () => boolean;
  }): SessionWorkItemReadOutcome;
}

export function createSessionWorkItemModule(input: {
  eventStore: Pick<
    EventStore,
    'conversationForSession' | 'listSessionWorkItemObservations'
  >;
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
}): SessionWorkItemModule {
  const permitted = (
    sessionId: string,
    authority: SessionReadAuthority,
    current: () => boolean,
  ) => current() && input.canReadSession(sessionId, authority);

  return {
    read(request) {
      try {
        if (
          !permitted(request.sessionId, request.authority, request.current) ||
          input.eventStore.conversationForSession(request.sessionId)
            ?.conversationId !== request.conversationId
        )
          return { status: 'not-found' };
        const projected = projectSessionWorkItemRead(
          {
            sessionId: request.sessionId,
            conversationId: request.conversationId,
          },
          input.eventStore.listSessionWorkItemObservations({
            sessionId: request.sessionId,
            conversationId: request.conversationId,
          }),
        );
        if (
          !permitted(request.sessionId, request.authority, request.current) ||
          input.eventStore.conversationForSession(request.sessionId)
            ?.conversationId !== request.conversationId
        )
          return { status: 'not-found' };
        return projected.kind === 'available'
          ? { status: 'found', projection: projected.projection }
          : { status: 'unavailable' };
      } catch {
        // Typed persistence corruption and ordinary durable failure have the
        // same public shape. Neither exposes stored bytes or existence facts.
        return { status: 'unavailable' };
      }
    },
  };
}
