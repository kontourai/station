import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { KnowledgeStoreUnavailableError } from './errors.js';

interface WriteAuthority {
  root: string;
  assertCurrent: () => void;
}
const authority = new AsyncLocalStorage<WriteAuthority>();

/** An additional request restriction; this never grants filesystem authority. */
export function withKnowledgeWriteAuthority<T>(
  root: string,
  assertCurrent: () => void,
  operation: () => T,
): T {
  return authority.run({ root: resolve(root), assertCurrent }, operation);
}

export function assertKnowledgeWriteAuthority(root: string): void {
  const current = authority.getStore();
  if (!current) return;
  if (current.root !== resolve(root))
    throw new KnowledgeStoreUnavailableError({
      cause: new Error(
        'Knowledge write target differs from the admitted source.',
      ),
    });
  current.assertCurrent();
}
