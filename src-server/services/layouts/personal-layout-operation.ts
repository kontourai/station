import type { LayoutOwner } from '@kontourai/station-contracts/layout';

const operations = new WeakMap<object, Map<string, Promise<void>>>();

/** Coordinates moves with edits over one store, before either destination is written. */
export async function withPersonalLayoutOperation<T>(
  store: object,
  owner: LayoutOwner,
  slug: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = operations.get(store);
  if (!queue) {
    queue = new Map();
    operations.set(store, queue);
  }
  const identity =
    owner.kind === 'principal'
      ? `principal:${owner.principal.id}`
      : owner.kind === 'project'
        ? `project:${owner.projectSlug}`
        : 'instance';
  const key = `${identity}\u0000${slug}`;
  const run = (queue.get(key) ?? Promise.resolve()).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queue.set(key, tail);
  try {
    return await run;
  } finally {
    if (queue.get(key) === tail) queue.delete(key);
  }
}
