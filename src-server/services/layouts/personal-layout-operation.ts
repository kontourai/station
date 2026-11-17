import type { LayoutOwner } from '@kontourai/station-contracts/layout';
import {
  createKeyedSerialQueue,
  type KeyedSerialQueue,
} from '../../utils/keyed-serial-queue.js';

const operations = new WeakMap<object, KeyedSerialQueue>();

/** Coordinates moves with edits over one store, before either destination is written. */
export async function withPersonalLayoutOperation<T>(
  store: object,
  owner: LayoutOwner,
  slug: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = operations.get(store);
  if (!queue) {
    queue = createKeyedSerialQueue();
    operations.set(store, queue);
  }
  const identity =
    owner.kind === 'principal'
      ? `principal:${owner.principal.id}`
      : owner.kind === 'project'
        ? `project:${owner.projectSlug}`
        : 'instance';
  const key = `${identity}\u0000${slug}`;
  return queue.run(key, operation);
}
