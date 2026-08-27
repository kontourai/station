import {
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './page-frame.css';
import {
  PageFrameContext,
  type PageFrameContextValue,
  type PageHeaderContent,
  samePageHeaderContent,
  useIsPageFramed,
  usePageFrameActionsSlot,
} from './page-frame-context';

/**
 * How a route's frame is shaped. Declared once per route in
 * `app-shell/page-frame-registry.ts`, never by the view.
 *
 * `width`
 *   `full`   — the content column the shell gives the route (1200px at 1440).
 *              The management default (owner decision D4/§density).
 *   `narrow` — 960px, left-aligned on the same x as `full`. Settings-like
 *              forms only; it changes the measure, never the origin.
 *
 * `body`
 *   `flow` — the body grows and `.content-view` scrolls it. Ordinary pages.
 *   `fill` — the body takes the remaining height and owns its own scrolling.
 *            Split panes, boards, log streams.
 *
 * `flush` — the body drops the frame's horizontal padding because the content
 *           is edge-to-edge chrome of its own (a split pane's list rail).
 */
export interface PageFrameSpec extends PageHeaderContent {
  width?: 'full' | 'narrow';
  body?: 'flow' | 'fill';
  flush?: boolean;
  /** Extra class on the frame root, for a route that still needs a hook. */
  className?: string;
  /** `data-first-run-anchor` for the frame root. */
  firstRunAnchor?: string;
}

/**
 * The one page shell.
 *
 * A route with a spec gets the canonical header (eyebrow · title · subtitle ·
 * right-aligned actions) at a single x-origin and top padding, above a body
 * whose width and scroll behaviour are the spec's to decide. A route without
 * one renders exactly what it rendered before — `PageFrame` is transparent,
 * not a wrapper with a null header, so surfaces that legitimately own their
 * whole viewport (the project workspace, a task, the new-project overlay) are
 * untouched.
 */
export function PageFrame({
  spec,
  routeIdentity,
  children,
}: {
  spec: PageFrameSpec | null;
  /**
   * Which route is on screen, from `app-shell/route-identity.ts` — the same
   * rule the route entrance and the sidebar's pending publisher key off. It
   * is what makes a title or an action belong to a ROUTE rather than to the
   * frame, which outlives every one of them.
   */
  routeIdentity: string;
  children: ReactNode;
}) {
  if (!spec) return <>{children}</>;
  return (
    <FramedPage spec={spec} routeIdentity={routeIdentity}>
      {children}
    </FramedPage>
  );
}

function FramedPage({
  spec,
  routeIdentity,
  children,
}: {
  spec: PageFrameSpec;
  routeIdentity: string;
  children: ReactNode;
}) {
  const [actionsNode, setActionsNode] = useState<HTMLElement | null>(null);
  const [mobileDetailNode, setMobileDetailNode] = useState<HTMLElement | null>(
    null,
  );
  const [mobileDetailSheetCount, setMobileDetailSheetCount] = useState(0);
  const [override, setOverride] = useState<PageHeaderContent | null>(null);
  const mobileDetailRegistrations = useRef(new Set<symbol>());

  const setHeaderOverride = useCallback((content: PageHeaderContent | null) => {
    setOverride((previous) =>
      samePageHeaderContent(previous, content) ? previous : content,
    );
  }, []);
  const registerMobileDetailSheet = useCallback(() => {
    const registration = Symbol('mobile-detail-sheet');
    const registrations = mobileDetailRegistrations.current;
    registrations.add(registration);
    setMobileDetailSheetCount(registrations.size);
    return () => {
      if (!registrations.delete(registration)) return;
      setMobileDetailSheetCount(registrations.size);
    };
  }, []);

  const context = useMemo<PageFrameContextValue>(
    () => ({
      actionsNode,
      mobileDetailNode,
      routeIdentity,
      setHeaderOverride,
      registerMobileDetailSheet,
    }),
    [
      actionsNode,
      mobileDetailNode,
      routeIdentity,
      setHeaderOverride,
      registerMobileDetailSheet,
    ],
  );

  // A published slot wins over the route table's default, per slot: a view
  // that only knows its subtitle does not have to restate its own title.
  const eyebrow = override?.eyebrow ?? spec.eyebrow;
  const title = override?.title ?? spec.title;
  const subtitle = override?.subtitle ?? spec.subtitle;

  const width = spec.width ?? 'full';
  const body = spec.body ?? 'flow';
  const className = [
    'page-frame',
    `page-frame--${width}`,
    `page-frame--${body}`,
    spec.flush ? 'page-frame--flush' : '',
    spec.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <PageFrameContext.Provider value={context}>
      <div
        className={className}
        data-first-run-anchor={spec.firstRunAnchor}
        inert={mobileDetailSheetCount > 0 || undefined}
      >
        <div className="page-frame__header">
          <div className="page__header">
            <div className="page__header-text">
              {eyebrow ? <div className="page__label">{eyebrow}</div> : null}
              <h1 className="page__title">{title}</h1>
              {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
            </div>
            {/*
              Keyed by the route, so the cell itself leaves with the route
              whose actions were portaled into it.

              The contributor-side rule in `page-frame-context` covers every
              contributor that still RENDERS. This covers the one that does
              not: when the next route's chunk is slow React keeps the
              departing view mounted but HIDDEN, which destroys its effects
              and never renders it again — and a portal's children do not live
              inside the hidden subtree, they live here, so nothing below the
              frame can withdraw them. Measured live before this: 1.5s of
              "Review" beside the Plugins page's Browse Registry and
              + Install Plugin.
            */}
            <div
              key={routeIdentity}
              className="page__actions"
              ref={setActionsNode}
            />
          </div>
        </div>
        <div className="page-frame__body">{children}</div>
      </div>
      <div
        key={routeIdentity}
        className="page-frame__mobile-detail-slot"
        ref={setMobileDetailNode}
      />
    </PageFrameContext.Provider>
  );
}

/**
 * Renders `children` into the page header's action cell.
 *
 * Outside a framed route it renders them where they stand, so a view that is
 * also mounted somewhere without a frame keeps its action rather than losing
 * it to a portal with nowhere to go. INSIDE a frame it renders nothing until
 * there is a cell to portal into, and nothing at all once the route it
 * mounted for has been left — a page action belongs to its page, and one left
 * in the next route's header is not just stale, it is clickable.
 */
export function PageFrameActions({ children }: { children: ReactNode }) {
  const framed = useIsPageFramed();
  const slot = usePageFrameActionsSlot();
  if (!framed) return <>{children}</>;
  if (!slot) return null;
  return createPortal(children, slot);
}

const IGNORE_HEADER = () => {};
const NOOP_MOBILE_DETAIL_REGISTRATION = () => () => {};

/**
 * Claims the page header for the host that renders this, so nothing below it
 * can publish one.
 *
 * Guidance is the case: it is one page with three tabs, and each tab's body
 * is itself a `SplitPaneLayout` that would otherwise publish its own
 * collection title over the page's. Whoever owns the tabs owns the title.
 * The action slot is deliberately still passed through — a tab's primary
 * action is still this page's primary action.
 */
export function PageHeaderScope({ children }: { children: ReactNode }) {
  const parent = useContext(PageFrameContext);
  const actionsNode = parent?.actionsNode ?? null;
  const mobileDetailNode = parent?.mobileDetailNode ?? null;
  const routeIdentity = parent?.routeIdentity ?? '';
  const registerMobileDetailSheet =
    parent?.registerMobileDetailSheet ?? NOOP_MOBILE_DETAIL_REGISTRATION;
  const value = useMemo<PageFrameContextValue | null>(
    () =>
      parent
        ? {
            actionsNode,
            mobileDetailNode,
            routeIdentity,
            setHeaderOverride: IGNORE_HEADER,
            registerMobileDetailSheet,
          }
        : null,
    [
      parent,
      actionsNode,
      mobileDetailNode,
      routeIdentity,
      registerMobileDetailSheet,
    ],
  );
  return (
    <PageFrameContext.Provider value={value}>
      {children}
    </PageFrameContext.Provider>
  );
}
