import {
  authenticatedFetch,
  useUpdateConfigMutation,
} from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useRef, useState, useSyncExternalStore } from 'react';
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
  /**
   * Whether THIS host has a telemetry endpoint. Optional because a paired
   * peer may be running an older build that does not report it; the summary
   * below then drops the clause rather than guessing, because "nothing is
   * sent" is a claim about a host, not a general reassurance.
   */
  endpointConfigured?: boolean;
  /**
   * The EFFECTIVE `telemetryEnabled` setting — the stored value folded over
   * the `STATION_TELEMETRY_ENABLED` fallback and the default, which is what
   * actually governs emission. Read rather than derived from `AppConfig`
   * alone so the first-run step cannot offer to turn off something the
   * environment has already turned off.
   */
  telemetryEnabled?: boolean;
};

/**
 * "Not now" — a dismissal that survives a reload.
 *
 * The dialog needs an exit that does not require the acknowledgement to
 * succeed — a revoked session, a 403, or an unwritable receipt path otherwise
 * traps the user behind a modal whose single action keeps failing, with the
 * connection-recovery UI it covers unreachable. But the
 * component re-mounts on every route, so component state would forget the
 * dismissal immediately; it lives here instead.
 *
 * The dismissal used to be page-lifetime only ("a reload shows it again
 * exactly as it does today"), which the #765 B1 re-verification proved is a
 * nag loop in practice: every full page load reset the module flag, so the
 * modal re-opened on every visit to `/` and followed the user to `/agents`,
 * where its focus trap swallowed the engine list. A declined disclosure is
 * therefore SNOOZED in localStorage (same pattern and reasoning as
 * `utils/activity-snooze-store.ts`): the modal stays away for
 * `SNOOZE_DURATION_MS`, then re-offers. It re-offers immediately when the
 * server publishes a different `inventoryRevision` — a changed inventory is
 * new information the user has not declined. The snooze is deliberately not a
 * substitute for the receipt: acknowledgement is still the only thing that
 * retires the disclosure for good, and the server-side flow is unchanged.
 */
export const USAGE_TELEMETRY_SNOOZE_STORAGE_KEY =
  'station.usage-telemetry-disclosure.snoozed';
/** A week: long enough to stop the every-visit nag, short enough that an unacknowledged inventory keeps resurfacing. */
export const USAGE_TELEMETRY_SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

type SnoozeRecord = {
  /** Epoch ms at which the snooze lapses. */
  until: number;
  /** The inventory the user declined; a different revision re-prompts. */
  inventoryRevision: string;
};

/** Read fresh on every check (cheap, and it is what makes a reload honest). */
function readSnoozeRecord(): SnoozeRecord | null {
  try {
    const raw = window.localStorage.getItem(USAGE_TELEMETRY_SNOOZE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.until !== 'number' ||
      typeof candidate.inventoryRevision !== 'string'
    ) {
      return null;
    }
    return {
      until: candidate.until,
      inventoryRevision: candidate.inventoryRevision,
    };
  } catch {
    // No storage (privacy mode, opaque origin) — the in-memory page-lifetime
    // flag below still covers this session.
    return null;
  }
}

function isSnoozedFor(inventoryRevision: string | undefined): boolean {
  const record = readSnoozeRecord();
  return (
    record !== null &&
    record.until > Date.now() &&
    record.inventoryRevision === (inventoryRevision ?? '')
  );
}

/**
 * The page-lifetime half of the dismissal: it keeps this session honest even
 * when localStorage is unavailable or the write fails, and it is what the
 * `useSyncExternalStore` subscription below actually observes.
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

/**
 * Every dismissal route — "Not now", ✕, Escape, a backdrop click, and the
 * first-run chapter closing over the disclosure step — lands here.
 */
export function dismissUsageTelemetryDisclosure(
  inventoryRevision: string | undefined,
): void {
  if (dismissedForPageLifetime) return;
  dismissedForPageLifetime = true;
  try {
    const record: SnoozeRecord = {
      until: Date.now() + USAGE_TELEMETRY_SNOOZE_DURATION_MS,
      inventoryRevision: inventoryRevision ?? '',
    };
    window.localStorage.setItem(
      USAGE_TELEMETRY_SNOOZE_STORAGE_KEY,
      JSON.stringify(record),
    );
  } catch {
    // Best-effort: the snooze is a convenience, not state worth failing over.
  }
  for (const listener of dismissalListeners) listener();
}

/** Module state and the snooze outlive a test; each case needs its own page. */
export function resetUsageTelemetryDisclosureDismissal(): void {
  dismissedForPageLifetime = false;
  try {
    window.localStorage.removeItem(USAGE_TELEMETRY_SNOOZE_STORAGE_KEY);
  } catch {
    // Nothing persisted, nothing to clear.
  }
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
  const pageDismissed = useSyncExternalStore(
    subscribeToDismissal,
    readDismissal,
  );
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
  // The persisted snooze is checked against the CURRENT inventory revision:
  // a snooze recorded for an older inventory does not cover a new one. Read
  // in render rather than through the store subscription because it needs the
  // query's answer; the subscription still forces the re-render whenever a
  // dismissal happens on this page.
  const dismissed =
    pageDismissed || isSnoozedFor(query.data?.inventoryRevision);
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
 * The sentence the first screen leads with, derived from what the host
 * reports rather than asserted.
 *
 * `endpointConfigured` is the whole reason the server reports it: "none is
 * configured here, so nothing is sent" is a claim about THIS Station, and
 * before #1582 A3 nothing in the API could see the endpoint at all (it is
 * read from the environment in `UsageTelemetryService`'s constructor). An
 * older peer that does not report it gets the clause dropped, not guessed.
 */
export function usageTelemetryDisclosureSummary(
  endpointConfigured: boolean | undefined,
): string {
  const lede =
    'Station can send anonymous usage events, only when a telemetry endpoint is configured';
  if (endpointConfigured === false)
    return `${lede}; none is configured here, so nothing is sent.`;
  if (endpointConfigured === true)
    return `${lede}; one is configured on this Station.`;
  return `${lede}.`;
}

/**
 * The two decisions the first screen offers, named after what they do.
 *
 * Both are derived from the EFFECTIVE setting, never from the label: on a
 * host the environment has already switched telemetry off, "Turn it off"
 * would be an action with nothing behind it and "Keep usage telemetry on"
 * would describe a state that is not the case.
 */
export function usageTelemetryDecisionLabels(enabled: boolean): {
  keep: string;
  change: string;
} {
  return enabled
    ? { keep: 'Keep usage telemetry on', change: 'Turn it off' }
    : { keep: 'Keep usage telemetry off', change: 'Turn it on' };
}

/**
 * The disclosure as the FIRST STEP of the guided first run, rather than as a
 * modal of its own over the top of it (UX audit follow-up to RT-02/SHELL-12).
 *
 * On a brand-new home both surfaces used to fire at once: the standalone
 * dialog is mounted by `OnboardingGate` after its children, so it landed at
 * `--layer-dialog` ON TOP of the first-run chapter — two modals on the first
 * screen a person ever sees, the second one unreadable underneath. The
 * disclosure belongs to onboarding, so on a `pending` home it is shown here,
 * and `OnboardingGate` does not mount the standalone modal at all.
 *
 * #1582 A3 — WHAT CHANGED AND WHY. The step used to open with the whole
 * generated schema (every event, every property, every domain) and two
 * buttons that named neither choice: "I understand" and "Not now". The
 * screen a person meets first is now a single derived sentence plus a
 * collapsed "See exactly what is sent" holding that same inventory, and the
 * buttons name the decision they make.
 *
 * THE SETTINGS TOGGLE IS THE SOURCE OF TRUTH. Both actions write and read
 * `telemetryEnabled` through the same `PUT /config/app` the Settings row
 * uses (`views/settings/StationConfigSection.tsx`), so this screen cannot
 * record a preference Settings does not show. "Keep" writes nothing — the
 * state it names is already the case — and only acknowledges; the changing
 * action writes first and acknowledges only once the write has landed, so a
 * refused write can never be reported as a saved choice.
 *
 * Chrome (scrim, focus trap, header, step count) belongs to
 * `FirstRunHomeChapter`'s dialog; this owns the summary, the inventory and
 * its two actions and nothing else. The exit that decides NOTHING is the
 * dialog's own close control, which still snoozes the disclosure and defers
 * the run (#765 B1) — see `FirstRunHomeChapter`'s `defer`.
 */
export function UsageTelemetryDisclosureStep({
  onAdvance,
}: {
  /** The decision landed — the run moves to its next step. */
  onAdvance: () => void;
}) {
  const { data, settled } = useUsageTelemetryDisclosureState();
  const acknowledge = useAcknowledgeDisclosure(onAdvance);
  const updateConfig = useUpdateConfigMutation();
  const [settingError, setSettingError] = useState(false);

  if (!settled || !data?.events) {
    return (
      <div data-testid="first-run-disclosure">
        <SkeletonBlock count={1} label="Loading what Station sends" />
      </div>
    );
  }

  // The server's own fold (`config ?? STATION_TELEMETRY_ENABLED ?? true`).
  // The `?? true` here is the same last link of that chain, for a peer too
  // old to report the field at all.
  const enabled = data.telemetryEnabled ?? true;
  const labels = usageTelemetryDecisionLabels(enabled);
  const busy = updateConfig.isPending || acknowledge.isPending;

  const decide = (next: boolean) => {
    if (busy) return;
    setSettingError(false);
    if (next === enabled) {
      // Nothing to write: the choice is the state the host is already in.
      acknowledge.mutate();
      return;
    }
    updateConfig.mutate(
      { telemetryEnabled: next },
      {
        onSuccess: (result) => {
          // A key the server declines comes back in `ignoredKeys` on a 2xx,
          // so a silent no-op would otherwise be acknowledged as a saved
          // choice — the setting still on, the receipt written, and the
          // reader told it was turned off.
          if (
            result.ignoredKeys?.some(
              (ignored) => ignored.key === 'telemetryEnabled',
            )
          ) {
            setSettingError(true);
            return;
          }
          acknowledge.mutate();
        },
        onError: () => setSettingError(true),
      },
    );
  };

  return (
    <div className="first-run-disclosure" data-testid="first-run-disclosure">
      <p className="first-run-chapter__lede">
        {usageTelemetryDisclosureSummary(data.endpointConfigured)}
      </p>
      <details className="first-run-disclosure__inventory">
        <summary>See exactly what is sent</summary>
        <div className="first-run-disclosure__body">
          <DisclosureInventory data={data} />
        </div>
      </details>
      <ResponsiveSurfaceActions className="first-run-chapter__actions">
        {settingError ? (
          <p className="usage-telemetry-disclosure__error" role="alert">
            The usage telemetry setting could not be saved.
          </p>
        ) : (
          acknowledgeErrorNotice(acknowledge.isError)
        )}
        <Button
          variant="secondary"
          aria-busy={busy}
          onClick={() => decide(!enabled)}
        >
          {labels.change}
        </Button>
        <Button
          variant="primary"
          aria-busy={busy}
          onClick={() => decide(enabled)}
        >
          {acknowledge.isError ? 'Try again' : labels.keep}
        </Button>
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
  const dismiss = () => dismissUsageTelemetryDisclosure(data.inventoryRevision);
  if (firstRun) {
    return (
      <Dialog
        // Escape, a backdrop click, and the "Not now" button below all reach
        // the same persisted dismissal. This dialog covers the whole app,
        // including the connection-recovery UI, and its acknowledgement can
        // fail persistently — so it must not be the only way out. The receipt
        // is still what stops it coming back for good; the dismissal only
        // snoozes it.
        onClose={dismiss}
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
            <Button variant="secondary" onClick={dismiss}>
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
