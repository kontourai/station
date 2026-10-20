import type {
  PaneConfirmDecision,
  PaneConfirmRequest,
  PaneHostFacts,
  WorkspacePaneHostContract,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import '../components/modals/PromptModal.css';
import { useIsMobile } from '../hooks/useIsMobile';
import { isComposingKeyEvent } from '../lib/isComposingKeyEvent';

/**
 * The two contract members whose implementation is the SHELL's own chrome and
 * the SHELL's own derivation, shared by both transports (archive#4201,
 * `docs/design/pane-host-contract.md`).
 *
 * `confirm` and `facts` are the members where "one interface, two transports"
 * is easiest to fake: an adapter could grow its own dialog state machine and
 * its own mobile read, satisfy the type, and drift. They live here instead, so
 * the in-process adapter and the frame adapter differ ONLY in how a call
 * reaches them — direct in tier 2, a message in tier 3 — which is exactly the
 * difference the design says should be the only one.
 */

interface PaneConfirmChrome {
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
  /**
   * Who asked, shown as the dialog's eyebrow ("From <requester>") so a
   * plugin's question cannot pass as Station's own. Omitted where the
   * transport already names the plugin (the frame prefixes the title).
   */
  requester?: string,
): PaneConfirmChrome {
  const [confirmRequest, setConfirmRequest] =
    useState<PaneConfirmRequest | null>(null);
  const confirmResolveRef = useRef<
    ((decision: PaneConfirmDecision) => void) | null
  >(null);
  const live = usePlacementLiveness(active);

  const confirm = useCallback(
    (request: PaneConfirmRequest) =>
      new Promise<PaneConfirmDecision>((resolve) => {
        // A host captured before the placement went away answers at once:
        // nothing can show this dialog any more.
        if (!live.current) {
          resolve('cancelled');
          return;
        }
        // A superseded request settles rather than dangles. This also bounds
        // the chrome to ONE dialog: a pane cannot stack modals on the user.
        confirmResolveRef.current?.('cancelled');
        confirmResolveRef.current = resolve;
        setConfirmRequest(request);
      }),
    [live],
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
      {...(requester ? { eyebrow: `From ${requester}` } : {})}
      onConfirm={() => settleConfirm('confirmed')}
      onCancel={() => settleConfirm('cancelled')}
    />
  );

  return { confirm, confirmChrome };
}

/**
 * Whether the placement can still show a dialog: true while mounted and
 * `active`. A request made through a host captured earlier reads this and
 * settles at once instead of opening a dialog nothing will render.
 */
function usePlacementLiveness(active: boolean) {
  // `active` is read from render, not from an effect: a child that opens a
  // dialog in its own mount effect, in the commit that activates the
  // placement, runs before this hook's effects and must already see `true`.
  const activeRef = useRef(active);
  activeRef.current = active;
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);
  return useRef({
    get current() {
      return !unmounted.current && activeRef.current;
    },
  }).current;
}

/** A prompt request: plain data, so the shell renders all of the dialog. */
interface PanePromptRequest {
  title: string;
  label?: string;
  initial?: string;
}

interface PanePromptChrome {
  /** Resolves the trimmed text, or `null`; never rejects. */
  prompt: (request: PanePromptRequest) => Promise<string | null>;
  /** The shell's prompt dialog; the placement renders it beside the pane. */
  promptChrome: ReactNode;
}

function stopAtPortal(event: PointerEvent) {
  event.stopPropagation();
}

/**
 * The prompt dialog, on the same `Dialog` chrome as the confirm dialog: the
 * requester eyebrow, a close button, Escape and backdrop dismissal.
 */
function HostPromptDialog({
  request,
  requester,
  onSubmit,
  onCancel,
}: {
  request: PanePromptRequest;
  requester?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [value, setValue] = useState(request.initial ?? '');
  useEffect(() => {
    // Rename-friendly: select the basename, as the shell's PromptModal does.
    const input = inputRef.current;
    if (!input) return;
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, []);
  const trimmed = value.trim();
  const submit = () => {
    if (trimmed) onSubmit(trimmed);
  };
  return createPortal(
    <div className="confirm-modal-portal" onPointerDown={stopAtPortal}>
      <Dialog
        title={request.title}
        {...(requester ? { eyebrow: `From ${requester}` } : {})}
        closeLabel={`Close ${request.title}`}
        onClose={onCancel}
        size="sm"
        initialFocusRef={inputRef}
        initialFocusPolicy="always"
        historyMode="none"
        footer={
          <>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={!trimmed}>
              OK
            </Button>
          </>
        }
      >
        {request.label ? (
          <label className="prompt-modal__label" htmlFor={inputId}>
            {request.label}
          </label>
        ) : null}
        <input
          ref={inputRef}
          id={inputId}
          className="prompt-modal__input"
          type="text"
          {...(request.label ? {} : { 'aria-label': request.title })}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isComposingKeyEvent(event)) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </Dialog>
    </div>,
    document.body,
  );
}

/**
 * The shell's one prompt dialog, the text-input sibling of
 * `usePaneConfirmChrome` with the same lifetime rules: one dialog at a time
 * (a newer request settles the older `null`), a request settles `null` when
 * the placement deactivates or unmounts, and a request made after that
 * settles `null` at once. Only the plugin SDK's `useHost().prompt` uses it
 * today; it is not yet a pane-host contract member, so the frame transport
 * has no prompt message.
 */
export function usePanePromptChrome(
  active: boolean,
  /** Shown as "From <requester>"; see `usePaneConfirmChrome`. */
  requester?: string,
): PanePromptChrome {
  const [promptRequest, setPromptRequest] = useState<PanePromptRequest | null>(
    null,
  );
  const resolveRef = useRef<((value: string | null) => void) | null>(null);
  const live = usePlacementLiveness(active);

  const prompt = useCallback(
    (request: PanePromptRequest) =>
      new Promise<string | null>((resolve) => {
        if (!live.current) {
          resolve(null);
          return;
        }
        resolveRef.current?.(null);
        resolveRef.current = resolve;
        setPromptRequest(request);
      }),
    [live],
  );

  const settle = useCallback((value: string | null) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setPromptRequest(null);
  }, []);

  useEffect(() => {
    if (active) return;
    resolveRef.current?.(null);
    resolveRef.current = null;
    setPromptRequest(null);
  }, [active]);
  // Unmount only: a cleanup on every re-run would cancel an open prompt.
  useEffect(
    () => () => {
      resolveRef.current?.(null);
      resolveRef.current = null;
    },
    [],
  );

  const promptChrome = promptRequest ? (
    <HostPromptDialog
      // A superseding request starts a fresh input.
      key={JSON.stringify(promptRequest)}
      request={promptRequest}
      {...(requester ? { requester } : {})}
      onSubmit={(value) => settle(value)}
      onCancel={() => settle(null)}
    />
  ) : null;

  return { prompt, promptChrome };
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
