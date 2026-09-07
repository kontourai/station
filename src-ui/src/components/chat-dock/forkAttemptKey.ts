import { randomCorrelationId } from '@kontourai/station-shared/random-id';

const STORAGE_KEY = 'station:conversation-fork-attempts:v1';
const MAX_ATTEMPTS = 64;

type AttemptMap = Record<string, string>;
const memoryAttempts: AttemptMap = {};

function coordinate(sourceConversationId: string, turnId: string): string {
  return `${sourceConversationId}\u0000${turnId}`;
}

function read(storage: Pick<Storage, 'getItem'>): AttemptMap {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    const persisted =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as AttemptMap)
        : {};
    // Memory wins: a quota/private-mode setItem failure may leave storage
    // absent or stale even though this page already minted the coordinate.
    return { ...persisted, ...memoryAttempts };
  } catch {
    return { ...memoryAttempts };
  }
}

function write(storage: Pick<Storage, 'setItem'>, attempts: AttemptMap) {
  const bounded = Object.fromEntries(
    Object.entries(attempts).slice(-MAX_ATTEMPTS),
  );
  for (const key of Object.keys(memoryAttempts)) delete memoryAttempts[key];
  Object.assign(memoryAttempts, bounded);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Private browsing/quota failure keeps same-page retry safety in memory.
  }
}

export function getOrCreateForkAttemptKey(
  sourceConversationId: string,
  turnId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  generate: () => string = () => randomCorrelationId(),
): string {
  const attempts = read(storage);
  const key = coordinate(sourceConversationId, turnId);
  if (typeof attempts[key] === 'string' && attempts[key]) return attempts[key];
  const idempotencyKey = generate();
  attempts[key] = idempotencyKey;
  write(storage, attempts);
  return idempotencyKey;
}

export function completeForkAttempt(
  sourceConversationId: string,
  turnId: string,
  idempotencyKey: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  const attempts = read(storage);
  const key = coordinate(sourceConversationId, turnId);
  if (attempts[key] !== idempotencyKey) return;
  delete attempts[key];
  write(storage, attempts);
}
