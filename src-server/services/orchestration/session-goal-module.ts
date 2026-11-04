import type {
  SessionGoalControlResult,
  SessionGoalRead,
} from '@kontourai/station-contracts/session-goal';
import {
  parseSessionGoalControlResult,
  parseSessionGoalRead,
  type SessionGoalCommand,
} from '@kontourai/station-contracts/session-goal';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';

interface SessionGoalAccess {
  current(): boolean;
  canRead(): boolean;
  canControl(): boolean;
}

export class SessionGoalModule {
  constructor(
    private readonly adapterFor: (
      id: string,
    ) => Pick<ProviderAdapterShape, 'goals'> | undefined,
  ) {}

  async read(
    id: string,
    access: SessionGoalAccess,
  ): Promise<SessionGoalRead | null> {
    if (!access.current() || !access.canRead()) return null;
    const adapter = this.adapterFor(id);
    if (!adapter) return { state: 'unavailable', reason: 'session-not-live' };
    const result: SessionGoalRead = adapter.goals
      ? (parseSessionGoalRead(await adapter.goals.read(id)) ?? {
          state: 'unavailable',
          reason: 'provider-unavailable',
        })
      : { state: 'unsupported' };
    return access.current() &&
      access.canRead() &&
      this.adapterFor(id) === adapter
      ? result
      : null;
  }

  async control(
    id: string,
    command: SessionGoalCommand,
    access: SessionGoalAccess,
  ): Promise<SessionGoalControlResult | null> {
    if (!access.current() || !access.canControl()) return null;
    const adapter = this.adapterFor(id);
    if (!adapter) return { state: 'refused', reason: 'session-not-live' };
    const result: SessionGoalControlResult = adapter.goals
      ? (parseSessionGoalControlResult(
          await adapter.goals.control(id, command),
        ) ?? { state: 'indeterminate' })
      : { state: 'unsupported' };
    return access.current() &&
      access.canControl() &&
      this.adapterFor(id) === adapter
      ? result
      : null;
  }
}
