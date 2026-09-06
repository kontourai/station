import {
  modelIdentityLabel,
  type SelectableModel,
} from '../../utils/modelCapabilities';

export interface WorkingDirectoryParts {
  parentPath: string;
  leafName: string;
  hasWorkingDirectory: boolean;
}

export function splitWorkingDirectoryPath(
  workingDirectory: string | null | undefined,
): WorkingDirectoryParts {
  if (!workingDirectory) {
    return {
      parentPath: '',
      leafName: '',
      hasWorkingDirectory: false,
    };
  }

  const parts = workingDirectory.replace(/\/+$/, '').split('/');
  const leafName = parts.pop() || '';
  const parentPath = parts.length ? `${parts.join('/')}/` : '';

  return {
    parentPath,
    leafName,
    hasWorkingDirectory: true,
  };
}

const DOCK_FIRST_RUN_KEY = 'station.dockFirstRunSeen';

/**
 * First-run nudge: a brand-new user lands with the chat dock collapsed and can
 * miss the primary surface entirely. This surfaces the dock once on the first
 * load. Returns false for automated sessions (`navigator.webdriver`) so e2e and
 * other tooling stay deterministic, and false once the nudge has been shown.
 */
export function shouldOpenDockForFirstRun(): boolean {
  if (typeof window === 'undefined') return false;
  if (navigator.webdriver) return false;
  try {
    return !window.localStorage.getItem(DOCK_FIRST_RUN_KEY);
  } catch {
    return false;
  }
}

export function markDockFirstRunSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DOCK_FIRST_RUN_KEY, '1');
  } catch {
    // Ignore storage failures (e.g. private mode); the nudge just won't persist.
  }
}

/**
 * #3013: whether an immutably project-scoped dock should ROUTE a request
 * targeting another project instead of handling it in place. The answer is
 * yes only when the route can actually be performed — this seam previously
 * claimed the route unconditionally while navigating only when a layout slug
 * existed, and every caller returned on that claim, so the user's click
 * (including New Chat agent selection) died with no chat, no navigation, and
 * no error.
 */
export function shouldRouteScopedChatProject(input: {
  hasImmutableProjectScope: boolean;
  targetProjectSlug: string | undefined;
  currentProjectSlug: string | undefined;
  layoutSlug: string | undefined;
}): boolean {
  return (
    input.hasImmutableProjectScope &&
    Boolean(input.targetProjectSlug) &&
    input.targetProjectSlug !== input.currentProjectSlug &&
    Boolean(input.layoutSlug)
  );
}

export type DockChrome = {
  isMobile: boolean;
  dockMode: string;
  isFullscreenPlacement: boolean;
};

/**
 * Whether the dock's inbox panel can mount in this chrome AT ALL — independent
 * of whether the user has it open (`inboxOpen`).
 *
 * kontourai/station#3314 review SF-1: the sidebar's "N more" promised the
 * inbox panel from every chrome, but the panel mounts only on desktop, and
 * there only in bottom mode or a fullscreen placement. On mobile the drawer
 * closed and the dock snapped to half, showing the CURRENT chat and no list;
 * in an edge placement nothing appeared at all. This predicate is shared by
 * the panel's own mount condition and by the `openCollection` routing that
 * has to reach it, so a caller cannot route to a surface this chrome does not
 * render.
 */
export function inboxPanelMounts({
  isMobile,
  dockMode,
  isFullscreenPlacement,
}: DockChrome): boolean {
  return !isMobile && (isFullscreenPlacement || dockMode === 'bottom');
}

/**
 * How long the inbox panel stays mounted after collapse to play its exit
 * (station#3309). Matches `--motion-base` (0.2s) in tokens.css — the CSS owns
 * the animation's duration, this owns when the element leaves the tree, and
 * the two have to agree or the panel is deleted mid-animation.
 */
export const CHAT_DOCK_INBOX_EXIT_MS = 200;

/**
 * The one expression for "which model is this chat actually running"
 * (station#3309). The dock header's identity chip and the delegation
 * launcher's inherited model are the same fact read from two places, and
 * station#3391 is what happens when a fact like this gets computed twice: Home
 * resolved a model id two ways and one of the answers showed a user an
 * internal id.
 *
 * Order matches the composer's own resolution — the live session override
 * first, then what the session reports, then the agent's default. `undefined`
 * when nothing reported one at all; the caller renders no model rather than
 * naming a guess.
 *
 * At the dock's call site `sessionModel` is currently unreachable: `composerModel`
 * is `useChatInput`'s own fold, which already falls back to the same session
 * field, so it is non-empty whenever this one would be. The arm is kept
 * because the parameter is the honest description of the precedence and a
 * second caller need not share that fold — but it is not doing work today,
 * and a test asserting it is asserting the shape, not a live path.
 */
export function effectiveChatModelId(input: {
  composerModel?: string | null;
  sessionModel?: string | null;
  agentDefaultModel?: string | null;
}): string | undefined {
  return (
    input.composerModel?.trim() ||
    input.sessionModel?.trim() ||
    input.agentDefaultModel?.trim() ||
    undefined
  );
}

/**
 * What to CALL the model a chat is running, for a surface that names it
 * alongside the composer (station#3309).
 *
 * Not a second derivation: `modelIdentityLabel` is the one rule, shared with
 * the composer chip, Home, the sidebar rows and the transcript's provenance
 * strip (#1536 B5). This adds only the `null` contract — no model id reported
 * means the caller shows nothing, rather than "Model not reported", which is a
 * claim about the SESSION and not something a compact identity row is entitled
 * to make.
 */
export function chatModelLabel(
  modelId: string | undefined,
  models: SelectableModel[],
): string | null {
  if (!modelId) return null;
  return modelIdentityLabel(modelId, models);
}

/**
 * Whether the mobile task-switcher sheet can mount in this chrome — the other
 * half of the same question `inboxPanelMounts` answers for desktop. Named so
 * the routing guarantee can be DERIVED for both surfaces instead of one being
 * asserted in a test comment.
 */
export function mobileTaskSwitcherMounts({ isMobile }: DockChrome): boolean {
  return isMobile;
}

/** The minimal shape every project-name lookup below needs. */
export interface ProjectNameLookup {
  slug: string;
  name: string;
}

/**
 * Plain slug -> display-name lookup, falling back to the slug itself when
 * the project isn't in the list (e.g. a stale reference mid-fetch). `null`
 * in, `null` out — every caller below already has its own "nothing bound"
 * branch and this must never invent a name for it.
 */
export function projectDisplayName(
  slug: string | null | undefined,
  projects: ProjectNameLookup[],
): string | null {
  if (!slug) return null;
  return projects.find((project) => project.slug === slug)?.name ?? slug;
}

interface DockProjectNameInput {
  /** The project CHAT-SCOPE filter (or a full-screen placement's own immutable project) — wins unconditionally. */
  scopedProjectSlug: string | null | undefined;
  /** The dock's own bound project (DockShell-owned, station#4525) — read only when no scope is active. */
  dockProjectSlug: string | null | undefined;
  sessionProjectSlug: string | null | undefined;
  sessionProjectName: string | null | undefined;
  projects: ProjectNameLookup[];
}

/**
 * The dock badge's displayed project name (station#4525) — the single
 * derivation both the desktop badge (`ChatDockProjectContext`'s
 * `projectName`) and the mobile header's named trigger use, so the two can
 * never disagree (kontourai/station#793 already required them to agree; a
 * hand-duplicated ternary at each call site is exactly how they'd drift).
 *
 * A project chat-scope filter always wins with a plain lookup. Otherwise,
 * when the active session actually belongs to the dock's bound project,
 * this prefers the session's own richer name resolution
 * (`sessionProjectName` — see `useChatDockViewModel`, which folds in
 * project-record/session/slug fallbacks a plain projects-list lookup does
 * not run); when the session belongs to a DIFFERENT project (or there is no
 * active session at all), it falls back to a plain lookup by the BOUND
 * slug — never the session's own name, which would be the exact
 * badge-shows-a-fact-about-the-wrong-project defect this issue is about.
 */
export function resolveDockBadgeProjectName(
  input: DockProjectNameInput,
): string | null {
  if (input.scopedProjectSlug) {
    return projectDisplayName(input.scopedProjectSlug, input.projects);
  }
  if (!input.dockProjectSlug) return null;
  if (input.sessionProjectSlug === input.dockProjectSlug) {
    return input.sessionProjectName || input.dockProjectSlug;
  }
  return projectDisplayName(input.dockProjectSlug, input.projects);
}

/**
 * station#4525 review MED-1 (owner design ruling): the badge always names
 * the dock's BOUND project (the owner's persistent-context design,
 * unchanged) — it never suppresses or substitutes the active session's own
 * directory, git, and layout-link facts for that. (Named without the
 * layout directory's path token: this file has no Coding dependency, and
 * the literal token anchors coding-composition-inventory-gate's semantic
 * scan — the same false-positive class PR #4527 fixed in Tabs.tsx.)
 * Those facts are truth about
 * the chat actually ON SCREEN and always derive from the active session,
 * unconditionally (station#1146 / review HIGH-2: a badge-gated fact row is
 * the exact defect station#1146 already fixed once, reintroduced).
 *
 * When the two diverge — an existing chat from a different project is open
 * while the dock is bound elsewhere — the header would otherwise imply the
 * visible transcript belongs to the badge's project. This is the muted
 * lead-in label the facts row shows in that case (e.g. "ProjectB ·
 * ~/dev/foo"); `null` on a genuine match, so the row renders exactly as it
 * did before this fix.
 */
export function resolveSessionProjectMismatchLabel(
  input: Omit<DockProjectNameInput, 'projects'>,
): string | null {
  if (input.scopedProjectSlug) return null;
  if (!input.sessionProjectSlug) return null;
  if (input.sessionProjectSlug === input.dockProjectSlug) return null;
  return input.sessionProjectName || input.sessionProjectSlug;
}

/**
 * station#4525 review HIGH-3 (blocking): what project a DIRECTLY-created
 * new chat (the pinned single-ready-agent New icon, `openNewChatDirect`)
 * should target. An immutably project-scoped placement (a project's own
 * Coding layout, `hasImmutableProjectScope`) must NEVER receive the dock's
 * ambient, device-global binding — passing it there trips
 * `shouldRouteScopedChatProject` into navigating away to the bound project
 * instead of creating a chat, silently eating the click (the exact HIGH-3
 * repro: New Chat inside `/projects/alpha/layouts/chat` navigated to the
 * globally-bound project and created nothing). Only the AMBIENT dock (no
 * immutable scope) inherits the binding; an immutable scope always targets
 * its OWN project, exactly as it did before this fix.
 */
export function resolveDirectNewChatProjectSlug(input: {
  hasImmutableProjectScope: boolean;
  immutableProjectSlug: string | undefined;
  dockChromeProjectSlug: string | null;
}): string | undefined {
  if (input.hasImmutableProjectScope) return input.immutableProjectSlug;
  return input.dockChromeProjectSlug ?? undefined;
}

/**
 * station#4525 review MED-3 (design ruling): the New Chat modal's own
 * project-selection step defaults to the dock's shell-owned binding when
 * one is set (the owner's persistent-context design) — but for a user who
 * has never bound one, this restores the PRE-station#4525 behavior
 * (`useActiveProject`, the route-level "project I am currently viewing")
 * rather than leaving the picker unbound. A fork confirmation always wins
 * outright (its own explicit source project, not a default at all — see
 * `resolveDockBadgeProjectName`'s sibling note on why a fork never syncs
 * the ambient binding either, station#4525 review LOW-1).
 */
export function resolveNewChatModalDefaultProjectSlug(input: {
  forkProjectSlug: string | undefined;
  hasImmutableProjectScope: boolean;
  immutableProjectSlug: string | undefined;
  dockChromeProjectSlug: string | null;
  routeActiveProjectSlug: string | null;
}): string | undefined {
  if (input.forkProjectSlug) return input.forkProjectSlug;
  if (input.hasImmutableProjectScope) return input.immutableProjectSlug;
  return (
    input.dockChromeProjectSlug ?? input.routeActiveProjectSlug ?? undefined
  );
}

export type OpenChatsCollectionRoute =
  | { surface: 'task-switcher-sheet' }
  | {
      surface: 'inbox-panel';
      /** The panel does not mount here yet; move the dock first. */
      switchToBottomMode: boolean;
      snapHalf: boolean;
    };

/**
 * Where "show me every open chat" has to go in this chrome, and what has to
 * change first for that destination to exist (#3314 review SF-1).
 *
 * Pure so the guarantee is testable: for EVERY chrome, applying this route
 * lands on a surface that actually mounts. The dock owns the effects.
 */
export function routeToOpenChatsCollection(
  chrome: DockChrome,
): OpenChatsCollectionRoute {
  if (chrome.isMobile) return { surface: 'task-switcher-sheet' };
  return {
    surface: 'inbox-panel',
    switchToBottomMode: !inboxPanelMounts(chrome),
    snapHalf: !chrome.isFullscreenPlacement,
  };
}
