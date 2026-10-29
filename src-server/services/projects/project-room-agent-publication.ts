import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { createLogger } from '../../utils/logger.js';
import type { EventBus } from '../orchestration/event-bus.js';
import type {
  ProjectRoomAgentAuthority,
  ProjectRoomAgentModule,
} from './project-room-agent-module.js';

const logger = createLogger({ name: 'project-room-agent-publication' });
const MAX_WATCHES = 128;
const LEASE_MS = 10 * 60_000;
type Watch = {
  authority: ProjectRoomAgentAuthority;
  sessionId: string;
  expiresAt: number;
  dirty: boolean;
};

/** Credentials stay in memory for one bounded execute-authorized observation lease.
 * Reopen/restart needs a fresh authorized request; durable captures alone grant nothing.
 */
export function createProjectRoomAgentPublication({
  eventBus,
  module,
}: {
  eventBus: EventBus;
  module: ProjectRoomAgentModule;
}) {
  let closed = false;
  let running: Promise<void> | undefined;
  const watches = new Map<string, Watch>();
  const current = (id: string, watch: Watch) => {
    if (closed || watches.get(id) !== watch || Date.now() >= watch.expiresAt)
      throw new Error('Room publication observation ended');
  };
  const pump = () => {
    if (closed || running) return;
    running = (async () => {
      for (;;) {
        if (closed) return;
        const next = [...watches].find(([, watch]) => watch.dirty);
        if (!next) return;
        const [id, watch] = next;
        watch.dirty = false;
        try {
          current(id, watch);
          await watch.authority.refresh?.();
          current(id, watch);
          const handle = await module.reconcile(watch.authority, id);
          current(id, watch);
          if (
            !['started', 'uncertain'].includes(handle.state) ||
            (handle.failure && handle.failure !== 'launch_uncertain')
          )
            watches.delete(id);
        } catch {
          // No retry loop and no launch: explicit Check answer can recover under
          // fresh authority. Do not retain a failed observer's credentials.
          if (watches.get(id) === watch) watches.delete(id);
          if (!closed)
            logger.warn(
              'Room answer observation ended; explicit recovery available',
            );
        }
      }
    })().finally(() => {
      running = undefined;
      if (!closed && [...watches.values()].some((watch) => watch.dirty)) pump();
    });
  };
  const unsubscribe = eventBus.subscribe((frame) => {
    if (closed || frame.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
    const event = frame.data?.event;
    if (
      !event ||
      typeof event !== 'object' ||
      !('method' in event) ||
      !['turn.completed', 'turn.aborted', 'runtime.error'].includes(
        String(event.method),
      ) ||
      !('threadId' in event) ||
      typeof event.threadId !== 'string'
    )
      return;
    for (const watch of watches.values()) {
      if (watch.sessionId === event.threadId) watch.dirty = true;
    }
    pump();
  });
  const expiry = setInterval(() => {
    for (const [id, watch] of watches) {
      if (Date.now() >= watch.expiresAt) watches.delete(id);
    }
  }, 30_000);
  expiry.unref();
  return {
    watch(authority: ProjectRoomAgentAuthority, id: string): void {
      if (closed || !authority.refresh) return;
      // Only the original authenticated requester with current compute/root
      // authority can recover a watch. The module validates the durable capture.
      const sessionId = module.publicationSession(authority, id);
      if (!sessionId) return;
      if (!watches.has(id) && watches.size >= MAX_WATCHES) return;
      const watch: Watch = {
        authority,
        sessionId,
        expiresAt: Date.now() + LEASE_MS,
        dirty: true,
      };
      watch.authority = {
        ...authority,
        assertCurrent() {
          current(id, watch);
          const result: unknown = authority.assertCurrent();
          if (result !== undefined)
            throw new Error('Room publication authority unavailable');
        },
        async refresh() {
          current(id, watch);
          await authority.refresh!();
          current(id, watch);
        },
      };
      watches.set(id, watch);
      // Probe after registration: completion during launch/before watch cannot
      // fall into a read/subscribe gap. Subsequent probes are terminal-driven.
      pump();
    },
    async close(): Promise<void> {
      closed = true;
      unsubscribe();
      clearInterval(expiry);
      watches.clear();
      await running;
    },
  };
}
