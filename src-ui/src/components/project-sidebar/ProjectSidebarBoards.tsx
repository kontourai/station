import {
  useCreatePersonalLayoutMutation,
  useDeletePersonalLayoutMutation,
  usePersonalLayoutsQuery,
  usePromotePersonalLayoutMutation,
  useUpdatePersonalLayoutMutation,
} from '@kontourai/station-sdk';
import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { boardPath } from '../../app-shell/board-route';
import { useProjects } from '../../contexts/ProjectsContext';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { NEW_BOARD_REQUEST_EVENT } from './new-board-events';
import './ProjectSidebarBoards.css';

/**
 * The panel's **Boards** section (#2062; design record D3 in
 * `docs/design/shell-ownership-and-boards.md`).
 *
 * A Board is a Layout owned by a principal rather than a project — the
 * project-less place D3 puts between Activity and Projects. This is NOT a
 * destination-registry entry, and that is the registry's own rule rather than
 * a shortcut: `sidebar: { order }` registers a fixed PLACE (Activity is the
 * only one), while a list of records the user creates and deletes at runtime
 * is rendered here the way Projects, Open chats and Drafts already are —
 * a `sidebar__section-label` header with a `+`, then a row per record.
 *
 * ## Hidden when empty
 *
 * D3's section is the viewer's personal Boards first, then instance-shared
 * ones. Only the personal half exists: slice #2061 shipped `/api/me/layouts`
 * and nothing lists instance-owned Layouts — there is a `{kind:'instance'}`
 * owner in the contract and a `layouts/instance/` directory in storage, but
 * no route, no client and no caller. So this section renders the personal
 * list, and "the instance shares none" is true by construction rather than by
 * a check. No placeholder marks a shared Board: a "Shared" label on a list
 * that cannot contain one would be a label nothing derives. When the
 * instance-sharing route lands, the marking lands with it.
 */
interface ProjectSidebarBoardsProps {
  collapsed: boolean;
  isMobile: boolean;
  navigate: (path: string) => void;
  /** Current route path; drives the active highlight. */
  activePath: string;
  onAfterNavigate?: () => void;
}

/** What a row can be doing instead of resting. */
type RowMode =
  | { kind: 'rest' }
  | { kind: 'rename'; slug: string }
  | { kind: 'menu'; slug: string }
  | { kind: 'confirm-delete'; slug: string }
  | { kind: 'pick-project'; slug: string };

/**
 * The placeholder a `+` Board wears until the user names it.
 *
 * NOT "New Board": that is the create control's own accessible name, and a
 * row wearing it would make two different controls answer to one name the
 * moment the first Board exists — the create button and the Board it just
 * created. "Untitled" also says the right thing: the name is missing, not
 * newly correct.
 */
const DEFAULT_BOARD_NAME = 'Untitled Board';

/**
 * A slug this viewer is not already using, derived from the default name.
 *
 * The slug is the Board's ADDRESS (the filename on disk and the segment in
 * its URL), and the server refuses a repeat with 409. Deriving a free one
 * here means the `+` always produces a Board rather than an error the user
 * did not ask a question to receive; the NAME stays the friendly duplicate
 * ("Untitled Board" twice is fine) because the name is not an identity.
 */
export function nextBoardSlug(taken: readonly string[]): string {
  const base = 'untitled-board';
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * One of the row's three `role="menu"` surfaces (#2083).
 *
 * WHAT THIS DOES NOT DO is the point. #2083 found this menu declaring
 * `role="menu"` without a single behaviour the role promises, and the fix
 * named in the issue is to adopt the repo's shared menu primitive rather than
 * grow five hand-rolled behaviours here. That primitive exists in two halves
 * and neither is a component:
 *
 * - `useMenuFocus` (`src-ui/src/hooks/useMenuFocus.ts`) owns focus entry on
 *   open, ArrowUp/ArrowDown/Home/End roving focus — gated on the container
 *   DECLARING `role="menu"`, which is why the attribute below is load-bearing
 *   rather than decorative — dismissal when focus leaves, and focus return to
 *   whatever opened the menu. `ProjectSidebarBoards` calls it; this component
 *   only receives the ref.
 * - `.menu-surface` / `.menu-row` (`src-ui/src/index.css`, with the
 *   coarse-pointer 44px row floor in `src-ui/src/components/chat/chat.css`)
 *   own the visual spec. Adopting them is what answers #2083's target-size
 *   half: the rows were `padding: 6px 8px` at `--text-sm`, about 26px, and the
 *   floor now comes from the shared rule every other menu in the app already
 *   uses instead of a fourth page-local coarse block.
 *
 * So all this wrapper adds is Escape, which every consumer of the primitive
 * still hand-rolls — `TurnActionsMenu` on its container, `ProfileMenu` and
 * `ChatDockHeaderMoreMenu` on a capturing document listener. The container
 * form is used here because this menu is IN FLOW inside the rail rather than
 * portalled, so there is no case where a key aimed at it is delivered
 * anywhere else first. Closing is all Escape does: the focus return is
 * `useMenuFocus`'s teardown, which is why nothing here touches the trigger.
 *
 * NO `.menu-row__glyph` SLOT on the rows below. The shared slot exists so
 * menus a reader compares in sequence start their labels on one x
 * (#1552 D4); every row here is a bare command, this surface sits in a 240px
 * rail rather than beside the header and dock menus that share that x, and
 * reserving 24px of a narrow menu to align with a menu that is never on
 * screen with it would cost width to align nothing.
 */
function BoardRowMenu({
  containerRef,
  label,
  onDismiss,
  children,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={containerRef}
      className="menu-surface sidebar__board-menu"
      role="menu"
      aria-label={label}
      // Required by `useMenuFocus`: a menu whose items have not arrived — the
      // project picker with no projects — has nothing focusable, and the
      // container is where focus lands instead.
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        // The shell carries document-level Escape handlers; dismissing a menu
        // is not also a request to close whatever is behind it.
        event.stopPropagation();
        onDismiss();
      }}
    >
      {children}
    </div>
  );
}

export function ProjectSidebarBoards({
  collapsed,
  isMobile,
  navigate,
  activePath,
  onAfterNavigate,
}: ProjectSidebarBoardsProps) {
  const { data: boards } = usePersonalLayoutsQuery();
  const { projects } = useProjects();
  const [mode, setMode] = useState<RowMode>({ kind: 'rest' });

  /**
   * The menu-bearing half of `RowMode`. Three kinds render a `role="menu"`;
   * `rest` and `rename` do not.
   */
  const menuOpen =
    mode.kind === 'menu' ||
    mode.kind === 'confirm-delete' ||
    mode.kind === 'pick-project';

  /**
   * The open row's `⋯` button, so the outside-pointer dismissal below can tell
   * "the user pressed somewhere else" from "the user pressed the control whose
   * whole job is toggling this menu".
   *
   * Without the distinction the trigger stops closing the menu: the dismissal
   * runs on `pointerdown` and sets `rest`, React re-renders, and the `click`
   * that follows reaches a handler that now reads `open === false` and opens
   * the menu straight back up.
   */
  const openTriggerRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Returns to `rest` only from the kind that asked.
   *
   * Every one of these is handed to `useMenuFocus` as its `onClose`, and its
   * focusout dismissal fires while the NEXT mode is already set: choosing
   * Rename mounts and focuses an input, choosing Delete mounts the confirm.
   * An unguarded `setMode({kind:'rest'})` there would close the surface the
   * user just opened, so the close is conditional on the mode that owns it
   * still being the current one — the same shape `TurnActionsMenu` uses.
   */
  const closeKind = useCallback((kind: RowMode['kind']) => {
    setMode((current) => (current.kind === kind ? { kind: 'rest' } : current));
  }, []);
  const closeMenu = useCallback(() => closeKind('menu'), [closeKind]);
  const closeConfirm = useCallback(
    () => closeKind('confirm-delete'),
    [closeKind],
  );
  const closePicker = useCallback(() => closeKind('pick-project'), [closeKind]);

  /**
   * One `useMenuFocus` per menu kind rather than one for "a menu is open".
   *
   * The hook keys its effects on the open flag, so a single call shared by all
   * three would not re-run when the user moves from the actions menu to the
   * confirm: the flag stays true, focus never enters the surface that just
   * mounted, and the roving-key listener stays bound to the container React
   * has already removed. Three flags flip correctly across exactly those
   * transitions. Only one row can be non-`rest` at a time — `mode` holds a
   * single slug — so three refs are enough for a list of any length, which is
   * also why these can be top-level hooks at all rather than one per row.
   */
  const menuRef = useMenuFocus<HTMLDivElement>(mode.kind === 'menu', closeMenu);
  const confirmRef = useMenuFocus<HTMLDivElement>(
    mode.kind === 'confirm-delete',
    closeConfirm,
  );
  const pickerRef = useMenuFocus<HTMLDivElement>(
    mode.kind === 'pick-project',
    closePicker,
  );

  /**
   * Outside-pointer dismissal.
   *
   * `useMenuFocus`'s focusout covers leaving by keyboard, and in a browser it
   * covers a press on a focusable element elsewhere. It does NOT cover a press
   * on ordinary page furniture — the rail's own background, a section label —
   * because that moves focus to `<body>` in some engines and nowhere at all in
   * others. A menu that only closes when focus happens to move is a menu that
   * stays open over the app.
   *
   * `pointerdown` in the capture phase, following `InfoTip` and
   * `DockPlacementControl`: the portalled header menus dismiss with a
   * full-viewport `.header-menu__dismiss-backdrop` button, which is not
   * available to a menu that renders in flow inside a scrolling rail.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (openTriggerRef.current?.contains(target)) return;
      for (const ref of [menuRef, confirmRef, pickerRef]) {
        if (ref.current?.contains(target)) return;
      }
      setMode({ kind: 'rest' });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true);
  }, [menuOpen, menuRef, confirmRef, pickerRef]);

  /**
   * Collapsing the rail closes any open menu (#2083).
   *
   * `.sidebar--collapsed .sidebar__board-menu` hides the menu and the trigger
   * stops rendering, while `mode` stayed set — so the section kept a mode
   * whose only exits were inside a surface nobody could see, and re-expanding
   * reopened a menu the user had not asked for. Closing on the transition is
   * what makes the collapsed rail a state with no unreachable modes in it.
   *
   * Scoped to the menu kinds. `rename` is deliberately left alone: its input
   * commits on blur, and clearing the mode here would unmount that input
   * instead, turning a commit into a discard — a behaviour change this issue
   * did not ask for.
   */
  useEffect(() => {
    if (!collapsed) return;
    setMode((current) =>
      current.kind === 'menu' ||
      current.kind === 'confirm-delete' ||
      current.kind === 'pick-project'
        ? { kind: 'rest' }
        : current,
    );
  }, [collapsed]);

  /**
   * Focuses the rename input WHEN IT MOUNTS.
   *
   * Not an effect keyed on `mode`, which is what this was and which never
   * fired for the `+` gesture: the create mutation's `onSuccess` runs in the
   * same commit as `invalidateQueries`, which only SCHEDULES a refetch
   * (`packages/sdk/src/query-domains/personalLayouts.ts`), so the new Board is
   * not in `rows` yet, no row renders, there is no input to focus — and the
   * effect does not run again when the row arrives, because `mode` has not
   * changed. A callback ref is called by React at the moment the node enters
   * the tree, whenever that turns out to be, which is the only event that
   * actually answers "the input exists now".
   *
   * Stable identity on purpose: a ref recreated each render would be detached
   * and reattached on every keystroke, re-selecting the text the user is
   * trying to edit.
   */
  const focusRenameInput = useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  /**
   * Set while a create is in flight that came from the command palette rather
   * than from the `+`, so `onSuccess` knows whether to open the new Board as
   * well as name it.
   *
   * A ref, not state: nothing renders differently for the two origins, and a
   * state write here would re-render the panel between the click and the
   * response for no visible reason.
   */
  const openOnCreate = useRef(false);

  const createBoard = useCreatePersonalLayoutMutation({
    // A Board created by `+` has a placeholder name, so the create is only
    // half the gesture — the user is naming it. Entering rename on success
    // rather than on click is what keeps the input bound to a record that
    // exists: renaming a Board the server refused would write to a slug that
    // is not there.
    onSuccess: (created) => {
      const fromPalette = openOnCreate.current;
      openOnCreate.current = false;

      // The `+` path. Its caller is already looking at the list the new row
      // joins — on a phone that means the drawer is open, because the `+` is
      // inside it — so the rename input is on screen and nothing navigates.
      if (!fromPalette) {
        setMode({ kind: 'rename', slug: created.slug });
        return;
      }

      // The palette path opens the Board, because its caller may not be
      // looking at the panel at all.
      navigate(boardPath(created.slug));

      // ...and on a phone it stops there (#2062 review F1). The panel is
      // rendered inside the mobile drawer, which carries
      // `aria-hidden={isMobile && !mobileOpen}` (`ProjectSidebar.tsx`), and
      // the drawer is normally CLOSED when the palette is used. Entering
      // rename mode would mount the input in that hidden subtree and the
      // callback ref would focus it: the caret would sit in an invisible
      // field inside a subtree screen readers are told does not exist, and
      // typing would go nowhere the user can see.
      //
      // Measured, not assumed. The review proposed keeping the drawer open
      // instead of auto-closing it; probing that fix reported
      // `focusedInsideHiddenNav: true` unchanged, because the drawer was
      // already closed and this component never opened it — the auto-close was
      // not the cause. Skipping rename is correct whatever the drawer is
      // doing, which is why it is the branch taken.
      //
      // DISCLOSED: a Board created this way on a phone arrives named
      // `Untitled Board`, and the row menu is the only place to rename it.
      // That menu's trigger is hover-revealed on pointer devices, so
      // `ProjectSidebarBoards.css` makes it permanently visible at the 44px
      // floor under `pointer: coarse` — without that block this disclosure
      // would be describing a remedy the stylesheet does not provide
      // (#2062 review M1). #2083 covers the menu's OTHER gaps (target size in
      // the pointer case, roving tabindex, arrows, Escape, outside-click); it
      // does not cover the hover-reveal rule, which is why that is fixed here
      // rather than deferred to it.
      if (isMobile) {
        // Closing the drawer is what puts the user ON the Board they just
        // created rather than behind the panel that created it. It was
        // dropped along with rename mode in the first pass at F1 and that was
        // a silent behaviour change, not a decision (#2062 review L3): the
        // footer's palette trigger (`ProjectSidebarFooter.tsx`) dispatches
        // from INSIDE the drawer without closing it, so that path really is
        // reachable with the drawer open. Restored deliberately, and a no-op
        // in the ordinary case where the drawer is already closed.
        //
        // What makes closing it safe is NOT "nothing is focused here", and
        // it is also not "the palette button holds focus" — two earlier
        // versions of this comment asserted each, and a probe at the close
        // point shows `document.activeElement` is `document.body`: the
        // palette closes before it runs the command and defers its own focus
        // restore a frame, and it mounts outside this `nav` anyway. What
        // actually holds is the drawer's own `restoreReturnFocus`
        // (`ProjectSidebar.tsx`), which moves focus back to the trigger that
        // opened it whenever it closes — a mechanism this path inherits
        // rather than one it provides. The difference matters: if that
        // restore were ever removed, closing from here WOULD strand focus in
        // a subtree about to be hidden, and the assertion that catches it is
        // in `ProjectSidebarBoards.test.tsx`, not here.
        onAfterNavigate?.();
        return;
      }
      setMode({ kind: 'rename', slug: created.slug });
    },
    // #2062 review F2 — without this, a refused create (409, 500, offline)
    // leaves `openOnCreate` stuck true, and the user's next `+` navigates
    // them away from where they were. `onSuccess` is not the only way a
    // mutation ends, and the SDK routes the other way to `onError`.
    onError: () => {
      openOnCreate.current = false;
    },
  });
  const renameBoard = useUpdatePersonalLayoutMutation();
  const deleteBoard = useDeletePersonalLayoutMutation();
  const promoteBoard = usePromotePersonalLayoutMutation();

  const rows = Array.isArray(boards) ? boards : [];

  /**
   * The command palette's "New Board" (#2062 review MED-6) runs THIS create,
   * not a copy of it — the slug derivation below is part of the gesture (the
   * server refuses a repeat with 409), and a second caller deriving its own
   * would be a second implementation of the same rule.
   *
   * Declared after `rows` because the derivation reads the current list. The
   * effect below does NOT depend on it — it reads this through a ref that is
   * refreshed every render, so the listener attaches once and still derives
   * the slug from the list as it stands when the event actually arrives.
   */
  const createBoardFromPalette = () => {
    if (createBoard.isPending) return;
    openOnCreate.current = true;
    createBoard.mutate({
      slug: nextBoardSlug(rows.map((row) => row.slug)),
      name: DEFAULT_BOARD_NAME,
    });
  };

  // Latest-ref, so the listener is attached ONCE. Subscribing to a handler
  // rebuilt every render would add and remove a window listener on every
  // keystroke of a rename, and the panel re-renders often.
  const createFromPalette = useRef(createBoardFromPalette);
  createFromPalette.current = createBoardFromPalette;

  useEffect(() => {
    const handle = () => createFromPalette.current();
    window.addEventListener(NEW_BOARD_REQUEST_EVENT, handle);
    return () => window.removeEventListener(NEW_BOARD_REQUEST_EVENT, handle);
  }, []);

  // Hidden when the viewer has no Boards. The section is a list of the
  // viewer's own things; an empty header with a `+` would take a row to
  // advertise a scope that holds nothing.
  //
  // This is a render-time `null`, and every hook above it has already run —
  // which is what keeps the palette's trigger alive for exactly the viewer
  // who cannot see the `+`.
  if (rows.length === 0 && mode.kind === 'rest') return null;

  const commitRename = (slug: string, name: string) => {
    setMode({ kind: 'rest' });
    const trimmed = name.trim();
    const current = rows.find((row) => row.slug === slug)?.name;
    if (!trimmed || trimmed === current) return;
    renameBoard.mutate({ layoutSlug: slug, update: { name: trimmed } });
  };

  return (
    <>
      <div className="sidebar__section-label sidebar__section-label--boards">
        <span className="sidebar__section-label-text">Boards</span>
        <button
          type="button"
          className="sidebar__section-add"
          aria-label="New Board"
          title="New Board"
          disabled={createBoard.isPending}
          onClick={() =>
            createBoard.mutate({
              slug: nextBoardSlug(rows.map((row) => row.slug)),
              name: DEFAULT_BOARD_NAME,
            })
          }
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      {rows.map((board) => {
        const path = boardPath(board.slug);
        const isActive = activePath === path;
        const renaming = mode.kind === 'rename' && mode.slug === board.slug;
        const open = mode.kind !== 'rest' && mode.slug === board.slug;
        return (
          <div className="sidebar__board-row" key={board.slug}>
            {/* The row's own line — the Board button (or its rename input)
                and the absolutely-positioned menu trigger — wrapped so the
                trigger is centred on THAT box and not on the whole row.

                Without this wrapper the trigger centres on
                `.sidebar__board-row`, which grows from 44px to ~138px when a
                menu opens below, sliding the trigger down on top of the
                menu's first item: a tap on Rename hit the trigger and closed
                the menu instead (#2062 review F1, measured in Chromium at
                33x27px of overlap). The projects list already solves this the
                same way — `.sidebar__project-row-main` in `ProjectSidebar.css`
                wraps its button and absolute controls with the expanded
                content outside it. */}
            <div className="sidebar__board-row-main">
              {renaming ? (
                <input
                  ref={focusRenameInput}
                  className="sidebar__board-rename"
                  type="text"
                  aria-label={`Rename ${board.name}`}
                  defaultValue={board.name}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRename(board.slug, event.currentTarget.value);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      // Discards the edit. Clearing the mode UNMOUNTS this
                      // input, and neither React nor a browser delivers a blur
                      // to a node that has been removed — so the discard is
                      // what makes the commit below unreachable afterwards.
                      // There is deliberately no guard in `onBlur` re-checking
                      // the mode: this element only exists while `renaming` is
                      // true, which is that exact condition, so such a guard's
                      // rejection path could never execute.
                      event.stopPropagation();
                      setMode({ kind: 'rest' });
                    }
                  }}
                  onBlur={(event) => {
                    commitRename(board.slug, event.currentTarget.value);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={`sidebar__project-btn${
                    isActive ? ' sidebar__project-btn--active' : ''
                  }`}
                  aria-current={isActive ? 'page' : undefined}
                  title={collapsed ? board.name : undefined}
                  onClick={() => {
                    navigate(path);
                    if (isMobile) onAfterNavigate?.();
                  }}
                >
                  <span aria-hidden="true" className="sidebar__board-glyph">
                    {board.icon ?? '▦'}
                  </span>
                  <span className="sidebar__project-name">{board.name}</span>
                </button>
              )}
              {!collapsed && !renaming && (
                <button
                  type="button"
                  // Only the OPEN row's trigger is recorded, which is all the
                  // outside-pointer dismissal needs and is what keeps a list of
                  // forty Boards from leaving thirty-nine stale nodes behind:
                  // the row whose menu is open is the only one whose press must
                  // not be read as "somewhere else".
                  ref={open ? openTriggerRef : undefined}
                  className="sidebar__board-menu-trigger"
                  aria-label={`${board.name} actions`}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={() =>
                    setMode(
                      open
                        ? { kind: 'rest' }
                        : { kind: 'menu', slug: board.slug },
                    )
                  }
                >
                  <span aria-hidden="true">⋯</span>
                </button>
              )}
            </div>
            {open && mode.kind === 'menu' && (
              <BoardRowMenu
                containerRef={menuRef}
                label={`${board.name} actions`}
                onDismiss={closeMenu}
              >
                <button
                  type="button"
                  className="menu-row"
                  role="menuitem"
                  onClick={() => setMode({ kind: 'rename', slug: board.slug })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="menu-row"
                  role="menuitem"
                  onClick={() =>
                    setMode({ kind: 'pick-project', slug: board.slug })
                  }
                >
                  Move to project…
                </button>
                <button
                  type="button"
                  className="menu-row"
                  role="menuitem"
                  onClick={() =>
                    setMode({ kind: 'confirm-delete', slug: board.slug })
                  }
                >
                  Delete
                </button>
              </BoardRowMenu>
            )}
            {open && mode.kind === 'confirm-delete' && (
              // Deleting is the one irreversible row action, and a Board can
              // hold a whole arrangement. The confirm lives in the same menu
              // rather than a Dialog so the panel stays free of dialog chrome
              // it would otherwise load eagerly.
              <BoardRowMenu
                containerRef={confirmRef}
                label={`Delete ${board.name}`}
                onDismiss={closeConfirm}
              >
                <p className="sidebar__board-confirm">Delete {board.name}?</p>
                <button
                  type="button"
                  className="menu-row"
                  role="menuitem"
                  onClick={() => {
                    setMode({ kind: 'rest' });
                    deleteBoard.mutate(board.slug);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="menu-row"
                  role="menuitem"
                  onClick={() => setMode({ kind: 'rest' })}
                >
                  Cancel
                </button>
              </BoardRowMenu>
            )}
            {open && mode.kind === 'pick-project' && (
              <BoardRowMenu
                containerRef={pickerRef}
                label={`Move ${board.name} to a project`}
                onDismiss={closePicker}
              >
                {/* Every project this Station holds. Station has no
                    per-project write authorization today — `GET /api/projects`
                    is the raw project listing and no project layout handler
                    applies a membership predicate — so a list claiming to be
                    "projects you can write" would be asserting a distinction
                    nothing computes. It offers what the server will accept.
                    `docs/design/project-membership.md` owns the contract that
                    would change this. */}
                {projects.length === 0 ? (
                  // Names the remedy rather than restating the noun. A picker
                  // with nothing to pick has already SHOWN that there are no
                  // projects; what the reader does not know is that creating
                  // one is what unblocks the move. Not the `Empty` primitive:
                  // that is a region-sized block with an icon and a title, and
                  // this is one line inside a row menu — rendering it here
                  // would pull the primitive into the panel's eager bundle to
                  // say less.
                  <p className="sidebar__board-confirm">
                    Create a project to move this Board into one.
                  </p>
                ) : (
                  projects.map((project) => (
                    <button
                      key={project.slug}
                      type="button"
                      className="menu-row"
                      role="menuitem"
                      onClick={() => {
                        setMode({ kind: 'rest' });
                        promoteBoard.mutate({
                          layoutSlug: board.slug,
                          projectSlug: project.slug,
                        });
                      }}
                    >
                      {project.name}
                    </button>
                  ))
                )}
              </BoardRowMenu>
            )}
          </div>
        );
      })}
    </>
  );
}
