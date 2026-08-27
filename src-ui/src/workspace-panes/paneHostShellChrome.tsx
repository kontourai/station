import type {
  PaneConfirmDecision,
  PaneConfirmRequest,
  PaneHostFacts,
  WorkspacePaneHostContract,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * The two contract members whose implementation is the SHELL's own chrome and
 * the SHELL's own derivation, shared by both transports (station#4201,
 * `docs/design/pane-host-contract.md`).
 *
 * `confirm` and `facts` are the members where "one interface, two transports"
 * is easiest to fake: an adapter could grow its own dialog state machine and
 * its own mobile read, satisfy the type, and drift. They live here instead, so
 * the in-process adapter and the frame adapter differ ONLY in how a call
 * reaches them — direct in tier 2, a message in tier 3 — which is exactly the
 * difference the design says should be the only one.
 */

export interface PaneConfirmChrome {
  /** The contract's `confirm` member — see the contract for its semantics. */
  confirm: WorkspacePaneHostContract['confirm'];
  /**
   * The shell's confirm chrome, rendered BY the placement (the design's "the
   * SHELL renders its own modal on the pane's behalf"). The pane only ever
   * sees `host.confirm(...)`'s promise; this element is how a transport
   * actually shows the dialog, so the placement must render it beside the
   * pane.
   */
  confirmChrome: ReactNode;
}

/**
 * The shell's one confirm dialog, driven by `host.confirm(...)`.
 *
 * `active` is whether the placement is CURRENTLY rendering its occupant and
 * this chrome. Required, with no default: a placement that calls this hook
 * above its own early returns (the ordinary shape -- hooks cannot be
 * conditional) keeps it mounted after the pane is gone, so this hook's own
 * unmount is the WRONG lifetime to settle against. Derive it from the same
 * predicate the early returns use so the two cannot drift.
 */
export function usePaneConfirmChrome(
  active: boolean,
  /**
   * A value that CHANGES whenever the occupant's own document is replaced,
   * for a transport where that can happen without this hook unmounting or
   * `active` flipping. The frame transport tears its plugin document down and
   * rebuilds it while the placement stays mounted, so neither of the other
   * two boundaries fires and an open dialog would survive into a document
   * that never asked for it — where answering it posts a decision to a frame
   * that is gone, and where the new document reusing a request id could take
   * that answer as the reply to a DIFFERENT question.
   *
   * Omitted means the placement's own mount is the only boundary, which is
   * true for an in-process pane: it has no document of its own to replace.
   */
  generation?: number,
): PaneConfirmChrome {
  const [confirmRequest, setConfirmRequest] =
    useState<PaneConfirmRequest | null>(null);
  const confirmResolveRef = useRef<
    ((decision: PaneConfirmDecision) => void) | null
  >(null);

  const confirm = useCallback(
    (request: PaneConfirmRequest) =>
      new Promise<PaneConfirmDecision>((resolve) => {
        // A superseded request settles rather than dangles. This also bounds
        // the chrome to ONE dialog: a pane cannot stack modals on the user.
        confirmResolveRef.current?.('cancelled');
        confirmResolveRef.current = resolve;
        setConfirmRequest(request);
      }),
    [],
  );

  const settleConfirm = useCallback((decision: PaneConfirmDecision) => {
    confirmResolveRef.current?.(decision);
    confirmResolveRef.current = null;
    setConfirmRequest(null);
  }, []);

  // A request the PANE does not outlive settles too. The superseded case
  // above is one of FOUR; the others are lifetimes that end while a dialog is
  // open, and they are not the same lifetime:
  //
  //  - the placement unmounts entirely (navigated away, replaced as the dock
  //    occupant, the frame torn down) -- the cleanup below;
  //  - the placement stays mounted but STOPS rendering the pane and this
  //    chrome, because one of its own guards started failing (a project
  //    deleted elsewhere, a background refetch erroring). This hook sits
  //    ABOVE those guards -- hooks cannot be conditional -- so its unmount
  //    never fires, and settling only there would leave the promise pending
  //    forever AND leave `confirmRequest` set, so the stale dialog would
  //    reappear if the guard later passed. Answering THAT dialog would run a
  //    dead pane's closure -- for the Board, a consent-gated intent for a
  //    pane the user already lost; across the frame, a decision delivered to
  //    a document that no longer exists.
  //
  // So deactivation settles exactly like an unmount, and clears the request
  // so nothing can resurface.
  // The occupant's document was replaced under a still-mounted placement.
  // Skips the first run: mounting is not a replacement, and settling there
  // would cancel a request made during the same commit.
  const settledGenerationRef = useRef(generation);
  useEffect(() => {
    if (settledGenerationRef.current === generation) return;
    settledGenerationRef.current = generation;
    confirmResolveRef.current?.('cancelled');
    confirmResolveRef.current = null;
    setConfirmRequest(null);
  }, [generation]);

  useEffect(() => {
    if (active) return;
    confirmResolveRef.current?.('cancelled');
    confirmResolveRef.current = null;
    setConfirmRequest(null);
  }, [active]);
  // Unmount-only deps on purpose: React runs a cleanup before EVERY re-run,
  // and settling on each render would cancel a dialog the user is reading.
  useEffect(
    () => () => {
      confirmResolveRef.current?.('cancelled');
      confirmResolveRef.current = null;
    },
    [],
  );

  const confirmChrome = (
    <ConfirmModal
      isOpen={confirmRequest !== null}
      title={confirmRequest?.title ?? ''}
      message={confirmRequest?.message ?? ''}
      onConfirm={() => settleConfirm('confirmed')}
      onCancel={() => settleConfirm('cancelled')}
    />
  );

  return { confirm, confirmChrome };
}

/**
 * The contract's `facts` member over the shell's single mobile derivation.
 *
 * `read` returns the current snapshot; `subscribe` pushes on change and
 * returns its unsubscribe. In-process that push is a callback the pane
 * registered; across the frame the adapter forwards it as a message. The
 * pane's code cannot tell, which is the point -- so neither transport gets to
 * invent its own device read.
 */
export function usePaneHostFacts(): WorkspacePaneHostContract['facts'] {
  const isMobile = useIsMobile();
  const factsRef = useRef<PaneHostFacts>({ device: { isMobile } });
  const listenersRef = useRef(new Set<(facts: PaneHostFacts) => void>());

  useEffect(() => {
    if (factsRef.current.device.isMobile === isMobile) return;
    factsRef.current = { device: { isMobile } };
    for (const listener of listenersRef.current) listener(factsRef.current);
  }, [isMobile]);

  return useMemo<WorkspacePaneHostContract['facts']>(
    () => ({
      read: () => factsRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );
}
