import type { KernelCommand, KernelResult } from '../commands.js';
import type {
  CommitParticipant,
  KernelContext,
  KernelStorage,
} from '../port.js';

/**
 * Somewhere a store's committed state lives, which can be opened again after
 * the "process" that had it open is gone. For a database adapter this is a
 * file; for the memory adapter, a volume object.
 */
export interface KernelStorageLocation {
  open(options?: {
    readonly participants?: readonly CommitParticipant<never>[];
  }): Promise<KernelStorage>;
  /** Remove everything the location created. */
  dispose(): Promise<void>;
}

/** How a conformance run gets fresh locations for one adapter. */
export interface KernelStorageHarness {
  readonly name: string;
  createLocation(): Promise<KernelStorageLocation>;
}

export class KernelCrashError extends Error {
  readonly code = 'MONUMENT_SIMULATED_CRASH';
  constructor(message = 'The store crashed before this command committed.') {
    super(message);
    this.name = 'KernelCrashError';
  }
}

export interface HeldCommit {
  /** Resolves with the command once it has reached the store. */
  readonly entered: Promise<KernelCommand>;
  /** Let the held command proceed to its commit. */
  release(): void;
}

/**
 * A store whose commit points a test controls:
 *
 * - {@link holdNextCommit}: the next command stops after reaching the store
 *   and before any of its writes, and signals `entered`.
 * - {@link crash}: the current "process" dies. A held command never commits
 *   and rejects with {@link KernelCrashError}; later commands reject until
 *   {@link reopen}.
 * - {@link failNextCommit}: the next command's transaction throws after its
 *   decision wrote, inside the real transaction, so the adapter must roll
 *   every write back.
 * - {@link reopen}: open the location again, as a restarted process would.
 *
 * A hold stops a command at the store's boundary, not halfway through its
 * transaction: a synchronous adapter has no halfway point a test could stop
 * at. That a failure halfway leaves nothing behind is what
 * {@link failNextCommit} proves, against the adapter's real rollback.
 */
export interface CrashPointStore {
  /**
   * One port for every incarnation: after {@link reopen} it routes to the
   * new one. A test that needs to hold the old process's handle cannot.
   */
  readonly storage: KernelStorage;
  holdNextCommit(): HeldCommit;
  failNextCommit(error?: Error): void;
  crash(): Promise<void>;
  reopen(): Promise<KernelStorage>;
  /** Close the current incarnation. The location stays for the caller. */
  dispose(): Promise<void>;
}

interface Incarnation {
  readonly inner: KernelStorage;
  crashed: boolean;
  readonly heldGates: Set<() => void>;
}

export async function openCrashPointStore(
  location: KernelStorageLocation,
  options: { readonly participants?: readonly CommitParticipant<never>[] } = {},
): Promise<CrashPointStore> {
  let failArmed: Error | undefined;
  let pendingHold:
    | {
        signal(command: KernelCommand): void;
        gate: Promise<void>;
        open(): void;
      }
    | undefined;
  const failure: CommitParticipant<unknown> = {
    name: 'crash-point-store',
    commit() {
      if (!failArmed) return;
      const error = failArmed;
      failArmed = undefined;
      throw error;
    },
  };
  const participants = [...(options.participants ?? []), failure];
  const openIncarnation = async (): Promise<Incarnation> => ({
    inner: await location.open({ participants }),
    crashed: false,
    heldGates: new Set(),
  });
  let current = await openIncarnation();

  const storage: KernelStorage = {
    async execute<C extends KernelCommand>(
      command: C,
      context: KernelContext,
    ): Promise<KernelResult<C>> {
      const incarnation = current;
      if (incarnation.crashed) throw new KernelCrashError();
      const hold = pendingHold;
      if (hold) {
        pendingHold = undefined;
        incarnation.heldGates.add(hold.open);
        hold.signal(command);
        await hold.gate;
        incarnation.heldGates.delete(hold.open);
        if (incarnation.crashed)
          throw new KernelCrashError(
            'The store crashed while this command was held; it never committed.',
          );
      }
      return incarnation.inner.execute(command, context);
    },
    close: () => current.inner.close(),
  };

  const crashCurrent = async () => {
    const incarnation = current;
    if (incarnation.crashed) return;
    incarnation.crashed = true;
    for (const open of incarnation.heldGates) open();
    await incarnation.inner.close();
  };

  return {
    storage,
    holdNextCommit() {
      if (pendingHold) throw new Error('A commit is already being held.');
      let signal!: (command: KernelCommand) => void;
      let open!: () => void;
      const entered = new Promise<KernelCommand>((resolve) => {
        signal = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      pendingHold = { signal, gate, open };
      return { entered, release: open };
    },
    failNextCommit(error = new Error('Injected commit failure.')) {
      failArmed = error;
    },
    crash: crashCurrent,
    async reopen() {
      await crashCurrent();
      pendingHold = undefined;
      failArmed = undefined;
      current = await openIncarnation();
      return storage;
    },
    dispose: crashCurrent,
  };
}
