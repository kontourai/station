/**
 * Per-path, in-process serialization for the file memory adapter's mutations.
 *
 * Held at module scope on purpose: several call sites construct their own
 * `FileMemoryAdapter`, so a per-instance queue would let two adapters in one
 * process interleave on the same file. The scope is deliberately IN-PROCESS;
 * `memory-adapter-messages.ts` documents what that does and does not cover.
 */
const fileMutations = new Map<string, Promise<unknown>>();

export async function withFileMutation<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = fileMutations.get(path) ?? Promise.resolve();
  // Chain off the settled tail: a rejected mutation must not poison the queue
  // for every later caller on this file.
  const next = previous.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  fileMutations.set(path, tail);
  try {
    return await next;
  } finally {
    // Release when still the tail, matching `persistConversation`'s
    // identity-guarded delete. Serialization is unaffected — a later caller
    // has already replaced the entry — and the map stops retaining one entry
    // per file mutated since boot, including for deleted conversations.
    if (fileMutations.get(path) === tail) fileMutations.delete(path);
  }
}
