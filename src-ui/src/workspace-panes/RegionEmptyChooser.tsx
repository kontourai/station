import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AgentGlyph,
  ChartGlyph,
  DiffGlyph,
  FolderGlyph,
  HomeGlyph,
  MessageGlyph,
  PhoneGlyph,
  TerminalGlyph,
} from '../components/icons/Glyph';
import { useRegionModel } from '../contexts/RegionModelContext';
import { describeOpenInRegionRefusal } from '../contexts/useOpenInRegion';
import { useMenuFocus } from '../hooks/useMenuFocus';
import {
  type DockRegionId,
  occupiedRegion,
  type RegisteredSurface,
  regionLabel,
} from '../regions/region-model';
import {
  type RegionPaneContext,
  regionSurfacePane,
} from '../regions/region-surface-panes';
import './RegionEmptyChooser.css';

/**
 * `RegisteredSurface.icon` → a glyph from the one factory (#1552 D1), for
 * every surface the registry can offer a dock region. The toolbar's
 * `SurfaceGlyph` covers three keys; this one covers the eight the registry
 * declares, so no row here reserves an empty slot. An unknown key still
 * renders nothing rather than a wrong glyph.
 */
function SurfaceGlyph({ icon }: { icon: string }) {
  switch (icon) {
    case 'chat':
      return <MessageGlyph />;
    case 'activity':
      return <ChartGlyph />;
    case 'agent':
      return <AgentGlyph />;
    case 'device':
      return <PhoneGlyph />;
    case 'terminal':
      return <TerminalGlyph />;
    case 'diff':
      return <DiffGlyph />;
    case 'files':
      return <FolderGlyph />;
    case 'home':
      return <HomeGlyph />;
    default:
      return null;
  }
}

/** The gap between the "+" and the panel it opens, above or below. */
const GAP = 4;

/**
 * Escape closes the panel, captured at the document so it wins over any
 * handler under it — the toolbar menus' rule (`ToolbarMenuSurface`).
 */
function useEscapeClosesPanel(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);
}

/**
 * One row of the chooser: a surface that declares this region, with what
 * choosing it does. `detail` is the row's secondary text, and for a disabled
 * row it is the REASON — part of the accessible name, so a keyboard or
 * screen-reader user is told why the row does nothing where a `title`
 * alone would not reach them.
 */
interface ChooserRow {
  surface: RegisteredSurface;
  detail: string | null;
  enabled: boolean;
}

/**
 * What an empty dock region offers (#2154): every surface the registry
 * declares for this region, in registry order — the same inventory the
 * toolbar's offer menu reads, with no `exposure` filter: the pane controls
 * what goes in it, and a catalog-only surface (Agents, Device, the coding
 * panes) is exactly what a region's own chooser is for. Home drops out by
 * its own `regions` (`main` only). No new placement rule lives here.
 *
 * A row is enabled iff the pane inventory can supply the surface's pane
 * under the dock's context (`regionSurfacePane(id).instance(context)`): a
 * coding pane has no instance without a project, so it lists disabled with
 * the dock's own sentence for that refusal (`unsupplied`) — listed, not
 * hidden, so the reader learns what the region COULD hold and what unlocks
 * it. A surface placed in another region is listed too (the toolbar's offer
 * menu already offers a placed surface) with "Move here from <Region>":
 * choosing it is `placeSurface`'s existing move, which hides the region it
 * empties (#2153). A surface this region already holds reads "Already here"
 * and choosing it reveals its tab, the model's own `held` branch.
 */
function chooserRows(
  surfaces: ReadonlyMap<string, RegisteredSurface>,
  regions: ReturnType<typeof useRegionModel>['regions'],
  regionId: DockRegionId,
  context: RegionPaneContext,
): ChooserRow[] {
  return [...surfaces.values()]
    .filter((surface) => surface.regions.includes(regionId))
    .map((surface) => {
      const pane = regionSurfacePane(surface.id);
      const enabled = pane !== undefined && pane.instance(context) !== null;
      const held = occupiedRegion(regions, surface.id);
      const detail = !enabled
        ? describeOpenInRegionRefusal('unsupplied')
        : held === undefined
          ? null
          : held === regionId
            ? 'Already here'
            : `Move here from ${regionLabel(held)}`;
      return { surface, detail, enabled };
    });
}

function ChooserRowButton({
  row,
  menuitem,
  onSelect,
}: {
  row: ChooserRow;
  /** In the panel a row is a `menuitem`; inline it is a plain button. */
  menuitem: boolean;
  onSelect: () => void;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const detailId = `${ids}-detail`;
  return (
    <button
      type="button"
      // Spread so an inline row carries no `role` attribute at all.
      {...(menuitem ? { role: 'menuitem' as const } : {})}
      className="menu-row region-chooser__row"
      // `aria-disabled`, not `disabled`: the row stays in the tab order and
      // its accessible name carries the reason (the same rule the toolbar's
      // inert region button applies, `RegionToolbarControls`).
      aria-disabled={row.enabled ? undefined : true}
      // The name is composed from the two rendered spans (#1868, the rule
      // `WorkspacePaneAvailabilityList` set): name-from-content joins
      // adjacent inline spans with nothing between them ("Chat:Move here"),
      // and a hand-written `aria-label` would be a composition the DOM does
      // not derive. `aria-labelledby` joins its references with a space.
      aria-labelledby={row.detail ? `${titleId} ${detailId}` : titleId}
      onClick={(event) => {
        event.stopPropagation();
        if (!row.enabled) return;
        onSelect();
      }}
    >
      <span className="menu-row__glyph" aria-hidden="true">
        <SurfaceGlyph icon={row.surface.icon} />
      </span>
      <span className="region-chooser__text">
        <span id={titleId} className="region-chooser__title">
          {row.surface.title}
        </span>
        {row.detail ? (
          <>
            {/* Real text for `textContent` (selection, find-in-page), clipped
                from view because the layout already separates the two. */}
            <span className="sr-only">{': '}</span>
            <span id={detailId} className="region-chooser__detail">
              {row.detail}
            </span>
          </>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The portalled panel a region's "+" opens: the same rows as a `menu` of
 * commands under the button, with the dismiss contract the toolbar's menus
 * carry (`ToolbarMenuSurface` in `RegionToolbarControls.tsx`, #1386): the
 * backdrop swallows the press and dismisses on the release, `pointercancel`
 * and click; Escape closes; `useMenuFocus` gives arrow-key roving focus,
 * focus entry and focus return. Duplicated rather than extracted because
 * that surface positions itself under the APP TOOLBAR (its class fixes
 * `top` to the toolbar's height); this one anchors under a button inside a
 * dock region and flips above it when there is no room below, the way a
 * tab's move menu does (#2112's rule: never slide up over the trigger).
 */
function ChooserPanel({
  regionId,
  anchor,
  onClose,
  children,
}: {
  regionId: DockRegionId;
  anchor: { right: number; top: number; bottom: number };
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  useEscapeClosesPanel(onClose);
  const [position, setPosition] = useState({
    right: Math.max(0, window.innerWidth - anchor.right),
    top: anchor.bottom + GAP,
  });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const box = menu.getBoundingClientRect();
    const right = Math.max(
      0,
      Math.min(window.innerWidth - anchor.right, window.innerWidth - box.width),
    );
    const below = anchor.bottom + GAP;
    const top =
      below + box.height <= window.innerHeight
        ? below
        : Math.max(0, anchor.top - GAP - box.height);
    setPosition((current) =>
      current.right === right && current.top === top ? current : { right, top },
    );
  }, [anchor, menuRef]);
  const dismiss = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onClose();
  };
  const label = regionLabel(regionId);
  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        className="header-menu__dismiss-backdrop chat-dock__more-backdrop"
        aria-label={`Close the Add to ${label} region menu`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerUp={dismiss}
        onPointerCancel={dismiss}
        onClick={dismiss}
      />
      <div
        ref={menuRef}
        className="menu-surface region-chooser__menu"
        role="menu"
        aria-label={`Add to ${label} region`}
        tabIndex={-1}
        style={{ right: position.right, top: position.top }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * The chooser an empty dock region shows in place of a pane (#2154), and
 * the panel its bar's "+" opens (#2154 replacing #2047 D4's catalog modal).
 * One row set, two renderings:
 *
 * - `inline`: the region's body — a labelled list of buttons, NOT a
 *   `role="menu"` (a list in a panel is navigated with Tab, and a menu's
 *   arrow keys would be a second navigation model for the same rows);
 * - `panel`: portalled under the "+", a `menu` of `menuitem` rows with a
 *   backdrop, Escape and focus return, closed by a choice.
 *
 * Choosing a row is `model.openSurfaceInRegion(id, { region })`: the model
 * places the surface (joining this region's panes, selected) or moves it
 * here from where it was, and the region host derives its document from
 * the arrangement. A refusal — a region this device does not offer, a
 * surface that does not declare it — is one sentence under the rows
 * (`describeOpenInRegionRefusal`), and the chooser stays open with it.
 *
 * Works without a project: the rows that need one list disabled with the
 * reason; Chat, Activity, Agents and Device do not need one. Bottom refuses
 * nothing — the registry's `regions` decide, and every dock surface declares
 * all three edges.
 */
export function RegionEmptyChooser({
  regionId,
  context,
  variant,
  anchor,
  onClose,
  pending = false,
}: {
  regionId: DockRegionId;
  /** The dock's project binding, which decides which rows are enabled. */
  context: RegionPaneContext;
  variant: 'inline' | 'panel';
  /** The "+" button's box, for the panel; ignored inline. */
  anchor?: { right: number; top: number; bottom: number };
  /** Closes the panel; ignored inline. */
  onClose?: () => void;
  /**
   * The dock's project read is in flight (inline only): the sentence
   * renders with NO rows, the rule the host's "+" applies — a projectless
   * `context` during the read would list the coding rows disabled with a
   * remedy for a state the user is not in, then flip them enabled.
   */
  pending?: boolean;
}) {
  const model = useRegionModel();
  const [notice, setNotice] = useState<string | null>(null);
  const rows = chooserRows(model.surfaces, model.regions, regionId, context);
  const label = regionLabel(regionId);
  const select = (surfaceId: string) => {
    const outcome = model.openSurfaceInRegion(surfaceId, { region: regionId });
    if (outcome.ok) {
      setNotice(null);
      onClose?.();
      return;
    }
    setNotice(describeOpenInRegionRefusal(outcome.reason));
  };
  const alert = notice ? (
    <p className="region-chooser__notice" role="alert">
      {notice}
    </p>
  ) : null;

  if (variant === 'panel') {
    if (!anchor || !onClose) {
      throw new Error('The panel chooser needs its anchor and onClose');
    }
    return (
      <ChooserPanel regionId={regionId} anchor={anchor} onClose={onClose}>
        {rows.map((row) => (
          <ChooserRowButton
            key={row.surface.id}
            row={row}
            menuitem
            onSelect={() => select(row.surface.id)}
          />
        ))}
        {alert}
      </ChooserPanel>
    );
  }

  return (
    <div className="dock-slot__body">
      <div className="region-chooser">
        {/* The #2153 placeholder sentence, kept as the list's own heading:
            a reader who closed the last tab and one who opened an empty
            region arrive at the same place and read the same thing. */}
        <p className="region-chooser__label">
          Nothing in the {label} region yet
        </p>
        {pending ? null : (
          <ul
            className="region-chooser__list"
            aria-label={`Add to ${label} region`}
          >
            {rows.map((row) => (
              <li key={row.surface.id}>
                <ChooserRowButton
                  row={row}
                  menuitem={false}
                  onSelect={() => select(row.surface.id)}
                />
              </li>
            ))}
          </ul>
        )}
        {alert}
      </div>
    </div>
  );
}
