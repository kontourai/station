/**
 * ConsoleBoardPane — the Board surface, extracted from `src-ui` into a
 * first-party package (epic station#4142 M4a; `docs/design/pane-or-shell.md`
 * Runtime tiers, tier 2: in-process React + SDK, published contracts only).
 * It mounts `@kontourai/console-ui`'s published `BoardView` (roadmap #586,
 * epic #580 S6) exactly as the former `src-ui/src/views/ConsoleBoardView.tsx`
 * did; the extraction moved code, not behavior.
 *
 * What this package may reach is the point: `@kontourai/console-ui`,
 * `@kontourai/station-sdk`, `@kontourai/ui`, `@kontourai/station-contracts`,
 * react — and nothing from `src-ui` or `src-server`
 * (`__tests__/package-boundary.test.ts` pins that). The shell affordances
 * the Board needs — navigation, the confirm chrome, the D8 redirect notice,
 * the mobile derivation — arrive through the published
 * `WorkspacePaneHostContract` (`docs/design/pane-host-contract.md`),
 * supplied by the pane's single mounter in core; the error primitive is the
 * published `@kontourai/station-sdk` `ErrorState`. The package declares WHAT
 * it needs; the shell decides HOW.
 *
 * `operatingState` is fetched from Station's own `/operating-state` route
 * (`OperatingStateService`, derived in-process server-side — see that
 * service's header) and fed to `BoardView` unchanged: this component does
 * no OperatingState derivation itself, matching `BoardView`'s own "pure
 * render, no fetching" contract.
 *
 * `onIntent` composes two concerns:
 *   1. `board.select-card` (Console's own view-only intent, `product:
 *      'console'` authority — BoardView's docs are explicit this is never
 *      routed through a product's descriptor bindings) is handled directly
 *      here: open the project workspace, carrying the recovered task slug.
 *   2. Any other intent is a candidate for the S5 capability-descriptor
 *      bindings — POSTed to Station's `/operating-state/intent` route
 *      (`resolveAndExecuteStationBoardIntent`, the server-side consent-
 *      gated resolve+execute). A `reason: 'consent-required'` response
 *      opens a confirmation modal; only an explicit confirm re-POSTs with
 *      `consent: true`. Console never executes anything itself — see
 *      `@kontourai/console-ui`'s own `IntentHandler` contract.
 */
import {
  BOARD_SELECT_CARD_INTENT,
  BoardView,
  type ConsoleIntent,
  deriveBoard,
} from '@kontourai/console-ui';
import '@kontourai/console-ui/board.css';
import type { WorkspacePaneHostContract } from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  type ConsoleBoardIntentInput,
  useBoardAvailabilityQuery,
  useConsoleBoardIntentMutation,
  useOperatingStateQuery,
} from '@kontourai/station-sdk';
import { ErrorState } from '@kontourai/station-sdk/error-state';
import { Empty, Skeleton } from '@kontourai/ui/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import './console-board-pane.css';

/**
 * Reverses `OperatingStateService.qualifiedWorkflowProcessId`'s
 * `[producer.product, scope.kind, scope.id, taskSlug].join(':')` scheme
 * (server-side source of truth: `src-server/services/operating-state-service.ts`,
 * `STATION_OPERATING_STATE_PRODUCT`/`_SCOPE_KIND`) — kept as a small,
 * self-contained mirror here rather than importing a server module into
 * the UI bundle. Returns `undefined` (fails closed) for any id that does
 * not carry this exact project's prefix.
 */
function taskSlugFromProcessId(
  processId: string,
  projectSlug: string,
): string | undefined {
  const prefix = `station:repo:${projectSlug}:`;
  if (!processId.startsWith(prefix)) return undefined;
  const slug = processId.slice(prefix.length);
  return slug.length > 0 ? slug : undefined;
}

/**
 * The Board's host is the pane-host contract itself (station#4201,
 * `docs/design/pane-host-contract.md` sequencing step 2) — the typed
 * injection this alias used to declare member-by-member is now the ONE
 * interface every Workspace Pane occupant is owed, in either runtime tier.
 * The two component slots the transitional host carried (`ErrorState`,
 * `ConfirmModal`) are gone by design: components never cross the contract.
 * `ErrorState` is the published `@kontourai/station-sdk` primitive imported
 * above, and confirmation is `host.confirm(...)` — the shell renders its own
 * modal on the pane's behalf. The alias is kept because "the Board's host"
 * is this package's vocabulary; the TYPE the mounter supplies is the
 * contract.
 */
export type ConsoleBoardPaneHost = WorkspacePaneHostContract;

/**
 * The Board's columns, named, on a phone (station#3777).
 *
 * `BoardView` lays its five stages out as `grid-auto-flow: column` with a
 * 220px minimum inside an `overflow-x: auto` scroller. At 390 that is ~1148px
 * of columns in ~358px of viewport: BACKLOG is visible, PLANNING is clipped,
 * and IN FLIGHT — the only column with a card on a project with a live run —
 * starts ~464px in, entirely off-screen, along with every column-header count.
 * The page itself does not scroll (the strip contains its own overflow), so
 * the mobile contract holds and a phone user still lands on what reads as an
 * empty board.
 *
 * This is the shared tab-strip primitive (`page__tabs tab-strip--scroll`,
 * the same markup `ConnectionsSectionFrame` uses), listing every stage with
 * its card count, so what is off-screen is stated rather than left to be
 * discovered by swiping. The columns come from the Kit's own published
 * `deriveBoard` — the exact projection `BoardView` renders from — so the
 * counts here cannot disagree with the board below.
 *
 * The active tab is DERIVED from the scroller's real position rather than set
 * on click, so a manual swipe cannot leave the strip pointing at a column the
 * user has scrolled away from.
 */
function BoardColumnStrip({
  columns,
  scrollerRef,
}: {
  columns: ReadonlyArray<{ stage: string; label: string; cards: unknown[] }>;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [activeIndex, setActiveIndex] = useState(0);

  const columnElements = useCallback((): HTMLElement[] => {
    const scroller = scrollerRef.current?.querySelector('.board-columns');
    return scroller ? (Array.from(scroller.children) as HTMLElement[]) : [];
  }, [scrollerRef]);

  const scrollToColumn = useCallback(
    (index: number) => {
      const element = columnElements()[index];
      const scroller = element?.parentElement;
      if (!element || !scroller) return;
      // `scrollLeft`, not `scrollTo`: one assignment, no options bag, and it
      // is the property jsdom implements, so the strip's own behaviour stays
      // testable rather than only observable in a browser.
      scroller.scrollLeft = element.offsetLeft - scroller.offsetLeft;
    },
    [columnElements],
  );

  /**
   * Land on the work, not on an empty BACKLOG. Runs once per board shape: the
   * first column that has a card is the one the user came to see.
   */
  const firstPopulated = columns.findIndex((column) => column.cards.length > 0);
  useEffect(() => {
    if (firstPopulated > 0) scrollToColumn(firstPopulated);
  }, [firstPopulated, scrollToColumn]);

  useEffect(() => {
    const scroller = scrollerRef.current?.querySelector('.board-columns');
    if (!scroller) return;
    const onScroll = () => {
      const elements = columnElements();
      if (elements.length === 0) return;
      const left = scroller.scrollLeft + scroller.clientWidth / 2;
      let nearest = 0;
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index] as HTMLElement;
        const start = element.offsetLeft - (scroller as HTMLElement).offsetLeft;
        if (start <= left) nearest = index;
      }
      setActiveIndex(nearest);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [columnElements, scrollerRef]);

  return (
    <div
      className="page__tabs tab-strip--scroll"
      role="tablist"
      aria-label="Flow stages"
    >
      {columns.map((column, index) => (
        <button
          key={column.stage}
          type="button"
          role="tab"
          aria-selected={index === activeIndex}
          className={`page__tab${index === activeIndex ? ' page__tab--active' : ''}`}
          onClick={() => scrollToColumn(index)}
        >
          {column.label} <span>{column.cards.length}</span>
        </button>
      ))}
    </div>
  );
}

/** The exact confirmation copy the Board has always shown, as contract data. */
function confirmRequestFor(intent: ConsoleBoardIntentInput): {
  title: string;
  message: string;
} {
  return {
    title: 'Confirm action',
    message: intent.label
      ? `Proceed with "${intent.label}"?`
      : 'Proceed with this action?',
  };
}

export interface ConsoleBoardPaneProps {
  projectSlug: string;
  host: ConsoleBoardPaneHost;
  /**
   * The legacy standalone route exists only when Builder has produced a run.
   * An explicitly installed Session Board layout is a durable workspace and
   * remains openable before its first run, where it renders the normal empty
   * state instead of redirecting out of the selected layout.
   */
  requireBuilderRun?: boolean;
}

export function ConsoleBoardPane({
  projectSlug,
  host,
  requireBuilderRun = true,
}: ConsoleBoardPaneProps) {
  /**
   * The shell's single mobile derivation, read through the contract's facts
   * channel: `read` is the snapshot, `subscribe` the change push — which is
   * exactly `useSyncExternalStore`'s shape, in either transport.
   */
  const isMobile = useSyncExternalStore(
    host.facts.subscribe,
    () => host.facts.read().device.isMobile,
    () => false,
  );
  const { data: boardAvailability, isLoading: availabilityLoading } =
    useBoardAvailabilityQuery(projectSlug);
  const {
    data: operatingState,
    isLoading,
    error,
    refetch,
  } = useOperatingStateQuery(projectSlug);
  const presentUnavailable = host.presentUnavailable;
  useEffect(() => {
    if (
      requireBuilderRun &&
      boardAvailability &&
      !boardAvailability.hasBuilderRun
    ) {
      // D8: the redirect has to SAY why, on the page it lands on. The host
      // owns both halves of that (the banner stack is shell chrome and the
      // route table is the shell's); what stays here is the derivation —
      // the server said it knows no Builder run for this project.
      presentUnavailable('no-builder-run');
    }
  }, [boardAvailability, presentUnavailable, requireBuilderRun]);
  const intentMutation = useConsoleBoardIntentMutation();

  /**
   * Open this Project's workspace, optionally landing on the recovered task
   * — the Board's one navigation intent, expressed as contract data; the
   * shell owns the path grammar it maps onto.
   */
  const openSelectedCard = useCallback(
    (intent: ConsoleIntent) => {
      const subjectId = intent.subjectRefs?.[0]?.id;
      const taskSlug = subjectId
        ? taskSlugFromProcessId(subjectId, projectSlug)
        : undefined;
      host.navigate({ kind: 'project-workspace', projectSlug, taskSlug });
    },
    [host.navigate, projectSlug],
  );

  const onIntent = useCallback(
    (intent: ConsoleIntent) => {
      if (intent.kind === BOARD_SELECT_CARD_INTENT) {
        openSelectedCard(intent);
        return;
      }
      const boardIntent = intent as ConsoleBoardIntentInput;
      intentMutation.mutate(
        { projectSlug, intent: boardIntent, consent: false },
        {
          onSuccess: (result) => {
            if (
              result.bound &&
              !result.executed &&
              result.reason === 'consent-required'
            ) {
              // The SHELL renders its confirm chrome on this pane's behalf
              // (`host.confirm`, the contract's one request/response intent)
              // — only an explicit confirm re-POSTs with `consent: true`.
              void host
                .confirm(confirmRequestFor(boardIntent))
                .then((decision) => {
                  if (decision !== 'confirmed') return;
                  intentMutation.mutate({
                    projectSlug,
                    intent: boardIntent,
                    consent: true,
                  });
                });
            }
          },
        },
      );
    },
    [host.confirm, intentMutation, openSelectedCard, projectSlug],
  );

  /**
   * The gate for "is there anything to show", NOT a receipt.
   *
   * station#3776: this used to be printed into the frame's action cell as
   * "N items in flight", ~40px above `BoardView`'s own `.board-receipt`
   * printing the same sentence — the same number twice, under two competing
   * titles ('Board' and 'Work in flight'). `@kontourai/console-ui@0.2.0`'s
   * `BoardView` takes four props (`operatingState`, `onIntent`,
   * `selectedCardId`, `now`) and exposes nothing to suppress its own header,
   * so Station cannot delete the Kit's copy. The Kit's number is the one that
   * survives: it is derived from the very projection rendered beneath it
   * (`deriveBoard(...).totalCards`), so it cannot disagree with the cards on
   * screen, while Station's was a second count of `processes.length` reached
   * by a different route. Upstream prop request: kontourai/ui.
   */
  const inFlight = operatingState?.processes?.length ?? 0;

  const boardRef = useRef<HTMLDivElement | null>(null);
  const boardColumns = useMemo(
    () => (operatingState ? deriveBoard(operatingState).columns : []),
    [operatingState],
  );

  return (
    <div className="page-layout console-board-view">
      {!availabilityLoading &&
      boardAvailability &&
      !boardAvailability.hasBuilderRun &&
      requireBuilderRun ? (
        /* The redirect above is already in flight; the notice travels with it
           on the banner stack, so this frame renders nothing rather than a
           second copy of the same sentence that vanishes a tick later. */
        <Skeleton />
      ) : (
        <>
          {isLoading && <Skeleton />}
          {error && (
            <ErrorState
              title={
                error instanceof Error
                  ? error.message
                  : 'Unable to load the board'
              }
              action={
                <button type="button" onClick={() => refetch()}>
                  Retry
                </button>
              }
            />
          )}
          {!isLoading && !error && operatingState && inFlight === 0 && (
            <Empty
              variant="prominent"
              label="No work in flight"
              description="Cards appear as the Builder run posts flow state."
            />
          )}
          {!isLoading && !error && operatingState && inFlight > 0 && (
            <div ref={boardRef}>
              {isMobile && boardColumns.length > 0 && (
                <BoardColumnStrip
                  columns={boardColumns}
                  scrollerRef={boardRef}
                />
              )}
              <BoardView operatingState={operatingState} onIntent={onIntent} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
