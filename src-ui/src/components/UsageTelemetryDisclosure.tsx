import { authenticatedFetch } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useRef, useSyncExternalStore } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { ResponsiveSurfaceActions } from './ResponsiveDialogSurface';
import { SkeletonBlock } from './state';

type Disclosure = {
  acknowledged: boolean;
  inventoryRevision: string;
  events: Record<
    string,
    {
      description: string;
      properties: Record<string, { domain: string | readonly string[] }>;
    }
  >;
};

/**
 * "Not now" for this page, and only this page.
 *
 * The dialog needs an exit that does not require the acknowledgement to
 * succeed — a revoked session, a 403, or an unwritable receipt path otherwise
 * traps the user behind a modal whose single action keeps failing, with the
 * connection-recovery UI it covers unreachable. But the
 * component re-mounts on every route, so component state would forget the
 * dismissal immediately; it lives here instead.
 *
 * Deliberately NOT persisted, and deliberately not a substitute for the
 * receipt: acknowledgement is the only thing that stops the disclosure coming
 * back, so a reload shows it again exactly as it does today. Same policy, and
 * the same reasoning, as `onboardingSetupStore`'s in-memory `deferredState`.
 */
let dismissedForPageLifetime = false;
const dismissalListeners = new Set<() => void>();

function subscribeToDismissal(listener: () => void): () => void {
  dismissalListeners.add(listener);
  return () => {
    dismissalListeners.delete(listener);
  };
}

function readDismissal(): boolean {
  return dismissedForPageLifetime;
}

function dismissForPageLifetime(): void {
  if (dismissedForPageLifetime) return;
  dismissedForPageLifetime = true;
  for (const listener of dismissalListeners) listener();
}

/** Page-lifetime state outlives a test; each case needs its own page. */
export function resetUsageTelemetryDisclosureDismissal(): void {
  dismissedForPageLifetime = false;
  for (const listener of dismissalListeners) listener();
}

/**
 * The disclosure route is mounted before `StationRuntime` finishes
 * constructing the service behind it, so a cold first paint legitimately meets
 * a 503. That is "not yet", not a failure — and the app's query defaults
 * (`retry: 1`, `refetchOnMount: false`, a five-minute `staleTime`) would cache
 * the resulting error state and withhold the disclosure for the whole session.
 * Distinguishing the status here is what lets the query keep asking.
 */
class UsageTelemetryNotReadyError extends Error {
  constructor() {
    super('Usage telemetry disclosure is not ready yet.');
    this.name = 'UsageTelemetryNotReadyError';
  }
}

/** ~10s of asking at a fixed interval; the service appears within a second. */
const NOT_READY_RETRY_LIMIT = 20;
const NOT_READY_RETRY_DELAY_MS = 500;

async function responseData(response: Response): Promise<Disclosure> {
  if (response.status === 503) throw new UsageTelemetryNotReadyError();
  if (!response.ok)
    throw new Error('Usage telemetry disclosure could not be loaded.');
  return (await response.json()).data;
}

/**
 * The one read of the inventory, shared by every surface that shows it.
 *
 * React Query dedupes on the key, so the first-run chapter asking whether
 * there is anything to disclose and the standalone modal deciding whether to
 * render are the SAME request — not two, and never two different answers.
 */
export interface UsageTelemetryDisclosureState {
  data: Disclosure | undefined;
  isError: boolean;
  /** The query has answered — with an inventory or with a failure. */
  settled: boolean;
  /** There is an unacknowledged inventory this page has not dismissed. */
  outstanding: boolean;
}

export function useUsageTelemetryDisclosureState(): UsageTelemetryDisclosureState {
  const { apiBase } = useApiBase();
  const dismissed = useSyncExternalStore(subscribeToDismissal, readDismissal);
  const query = useQuery({
    queryKey: ['usage-telemetry-disclosure', apiBase],
    queryFn: () =>
      authenticatedFetch(`${apiBase}/api/usage-telemetry/disclosure`).then(
        responseData,
      ),
    retry: (failureCount, error) =>
      error instanceof UsageTelemetryNotReadyError
        ? failureCount < NOT_READY_RETRY_LIMIT
        : failureCount < 1,
    retryDelay: (failureCount, error) =>
      error instanceof UsageTelemetryNotReadyError
        ? NOT_READY_RETRY_DELAY_MS
        : Math.min(1000 * 2 ** failureCount, 30_000),
  });
  return {
    data: query.data,
    isError: query.isError,
    settled: !query.isLoading,
    // `events` is read with Object.entries below: a host that answers with an
    // unexpected shape (older build, error envelope) must degrade to showing
    // nothing, not throw through the app shell and blank the window.
    outstanding:
      !query.isLoading &&
      !!query.data?.events &&
      !query.data.acknowledged &&
      !dismissed,
  };
}

function useAcknowledgeDisclosure(onAcknowledged?: () => void) {
  const { apiBase } = useApiBase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      authenticatedFetch(
        `${apiBase}/api/usage-telemetry/disclosure/acknowledgements`,
        { method: 'POST' },
      ).then(responseData),
    onSuccess: (data) => {
      queryClient.setQueryData(['usage-telemetry-disclosure', apiBase], data);
      onAcknowledged?.();
    },
  });
}

/** The inventory itself — one copy, rendered by all three presentations. */
function DisclosureInventory({ data }: { data: Disclosure }) {
  return (
    <>
      <p className="usage-telemetry-disclosure__lede">
        Station sends the following anonymous product-usage events only when a
        telemetry endpoint is configured. It never sends conversation content,
        filesystem paths, repository names, hostnames, branches, account
        identities, or other free text.
      </p>
      {Object.entries(data.events).map(([event, definition]) => (
        <div className="usage-telemetry-disclosure__event" key={event}>
          <strong>{event}</strong>
          <p>{definition.description}</p>
          <ul>
            {Object.entries(definition.properties).map(([property, detail]) => (
              <li key={property}>
                <code>{property}</code>:{' '}
                {Array.isArray(detail.domain)
                  ? detail.domain.join(', ')
                  : detail.domain}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function acknowledgeErrorNotice(isError: boolean): ReactNode {
  return isError ? (
    <p className="usage-telemetry-disclosure__error" role="alert">
      The disclosure acknowledgement could not be saved.
    </p>
  ) : null;
}

/**
 * The disclosure as the FIRST STEP of the guided first run, rather than as a
 * modal of its own over the top of it ( follow-up to /).
 *
 * On a brand-new home both surfaces used to fire at once: this dialog is
 * mounted by `OnboardingGate` after its children, so it landed at
 * `--layer-dialog` ON TOP of the first-run chapter — two modals on the first
 * screen a person ever sees, the second one unreadable underneath. The
 * disclosure belongs to onboarding, so on a `pending` home it is shown here,
 * and `OnboardingGate` does not mount the standalone modal at all.
 *
 * Same copy, same acknowledgement, same "Not now": deferring advances the run
 * without writing a receipt, and the standalone modal re-offers on the next
 * load exactly as it does today. Chrome (scrim, focus trap, header, step
 * count) belongs to `FirstRunHomeChapter`'s dialog; this owns the inventory
 * and its two actions and nothing else.
 */
export function UsageTelemetryDisclosureStep({
  onAdvance,
}: {
  onAdvance: () => void;
}) {
  const { data, settled } = useUsageTelemetryDisclosureState();
  const acknowledge = useAcknowledgeDisclosure(onAdvance);

  if (!settled || !data?.events) {
    return (
      <div data-testid="first-run-disclosure">
        <SkeletonBlock count={1} label="Loading what Station sends" />
      </div>
    );
  }

  return (
    <div className="first-run-disclosure" data-testid="first-run-disclosure">
      <div className="first-run-disclosure__body">
        <DisclosureInventory data={data} />
      </div>
      <ResponsiveSurfaceActions className="first-run-chapter__actions">
        {acknowledgeErrorNotice(acknowledge.isError)}
        {/* "Not now" is the same decision it is in the standalone modal: the
            run moves on, no receipt is written, and the disclosure is offered
            again on the next load. It never ends the first run — that is the
            dialog's own close, one step down. */}
        <button
          type="button"
          className="editor-btn"
          onClick={() => {
            dismissForPageLifetime();
            onAdvance();
          }}
        >
          Not now
        </button>
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          aria-busy={acknowledge.isPending}
          aria-disabled={acknowledge.isPending}
          onClick={() => {
            if (acknowledge.isPending) return;
            acknowledge.mutate();
          }}
        >
          {acknowledge.isError ? 'Try again' : 'I understand'}
        </button>
      </ResponsiveSurfaceActions>
    </div>
  );
}

/** Uses the server inventory directly; no second event/property list may drift. */
export function UsageTelemetryDisclosure({
  firstRun = false,
}: {
  firstRun?: boolean;
}) {
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  const { data, isError, settled, outstanding } =
    useUsageTelemetryDisclosureState();
  const acknowledge = useAcknowledgeDisclosure();
  if (!settled || !data?.events || (!firstRun && isError)) return null;
  if (firstRun && !outstanding) return null;

  const acknowledgeButton = (
    <Button
      ref={acknowledgeRef}
      variant="primary"
      onClick={() => acknowledge.mutate()}
      disabled={acknowledge.isPending}
    >
      {acknowledge.isError ? 'Try again' : 'I understand'}
    </Button>
  );
  const body = <DisclosureInventory data={data} />;
  const acknowledgeError: ReactNode = acknowledgeErrorNotice(
    acknowledge.isError,
  );

  // First run is a dialog, not a floating panel. The inventory is generated
  // server-side and grows with the event list, so the surface has to cap at
  // the viewport and scroll its own body — the launcher card it used to borrow
  // had no bound at all and ran off the top and bottom of the screen with the
  // single action stranded below the fold.
  if (firstRun) {
    return (
      <Dialog
        // Escape, a backdrop click, and the "Not now" button below all reach
        // the same page-lifetime dismissal. This dialog covers the whole app,
        // including the connection-recovery UI, and its acknowledgement can
        // fail persistently — so it must not be the only way out. The receipt
        // is still what stops it coming back.
        onClose={dismissForPageLifetime}
        closeLabel="Close usage telemetry disclosure"
        // Focus the primary action rather than the panel: the panel is what
        // the surface focuses by default, and a focus ring around the whole
        // dialog reads as a selection, not as "press this".
        initialFocusRef={acknowledgeRef}
        initialFocusPolicy="always"
        eyebrow="Usage telemetry"
        title="What Station sends"
        size="lg"
        panelClassName="usage-telemetry-disclosure"
        historyMode="none"
        footer={
          <>
            {acknowledgeError}
            <Button variant="secondary" onClick={dismissForPageLifetime}>
              Not now
            </Button>
            {acknowledgeButton}
          </>
        }
      >
        <div data-testid="usage-telemetry-disclosure-modal">{body}</div>
      </Dialog>
    );
  }

  return (
    <section
      aria-label="Usage telemetry disclosure"
      className="usage-telemetry-disclosure"
    >
      <div className="usage-telemetry-disclosure__eyebrow">Usage telemetry</div>
      <h2>What Station sends</h2>
      {body}
      <p>
        {data.acknowledged
          ? 'You acknowledged this inventory.'
          : acknowledgeButton}
      </p>
      {acknowledgeError}
    </section>
  );
}
