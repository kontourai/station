import type { PendingPairingExchange } from './devicePairing';
import type {
  CompletePendingPairingOptions,
  PendingPairingCompletion,
} from './pendingPairingCompletion';

/**
 * The eager connect entrypoint is shared by the initial application shell.
 * Keep the pairing protocol implementation behind this narrow, cached loader:
 * callers retain the same total async Interface without paying for polling,
 * retry, and subscriber coordination before a persisted request exists.
 */
export type CompletePendingPairing = (
  pending: PendingPairingExchange,
  options: CompletePendingPairingOptions,
) => Promise<PendingPairingCompletion>;

type LoadImplementation = () => Promise<{
  completePendingPairing: CompletePendingPairing;
}>;

/**
 * Internal construction seam for deterministic loader tests. It remains off
 * the package entrypoint with the implementation it protects.
 */
export function createPendingPairingCompletionLoader(
  importImplementation: LoadImplementation = () =>
    import('./pendingPairingCompletion'),
) {
  let implementation: CompletePendingPairing | undefined;
  let loading: Promise<CompletePendingPairing> | undefined;

  const loadPendingPairingCompletion = (): Promise<CompletePendingPairing> => {
    if (implementation) return Promise.resolve(implementation);
    if (loading) return loading;

    loading = importImplementation().then(
      ({ completePendingPairing }) => {
        implementation = completePendingPairing;
        loading = undefined;
        return completePendingPairing;
      },
      (error: unknown) => {
        // A failed chunk load must not poison future retries. No pairing work
        // has started yet, so retaining the persisted request is safe.
        loading = undefined;
        throw error;
      },
    );
    return loading;
  };

  const completePendingPairing: CompletePendingPairing = async (
    pending,
    options,
  ) => {
    try {
      return await (await loadPendingPairingCompletion())(pending, options);
    } catch {
      // Loading precedes exchange, so this is a total local failure without
      // consuming or clearing the pending bearer request.
      return { status: 'failed' };
    }
  };

  return { completePendingPairing, loadPendingPairingCompletion };
}

/**
 * Public compatibility façade for callers that already use the completion
 * Interface. The implementation is shared after its first demand load.
 */
export const { completePendingPairing } =
  createPendingPairingCompletionLoader();
