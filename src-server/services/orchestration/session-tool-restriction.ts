import { AsyncLocalStorage } from 'node:async_hooks';

/** Process-local capability; never serialized or accepted from command JSON. */
export interface SessionToolRestriction {
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly nativeBindingKey: string;
  readonly generation: string;
  readonly clientTurnId: string;
  assertCurrent(): void;
}

const current = new AsyncLocalStorage<SessionToolRestriction>();

export function sessionToolRestriction(
  threadId: string,
): SessionToolRestriction | undefined {
  const restriction = current.getStore();
  if (restriction && restriction.threadId !== threadId)
    throw new Error('group_sync_activation_changed');
  restriction?.assertCurrent();
  return restriction;
}

export function withSessionToolRestriction<T>(
  restriction: SessionToolRestriction,
  operation: () => Promise<T>,
): Promise<T> {
  restriction.assertCurrent();
  return current.run(restriction, operation);
}
