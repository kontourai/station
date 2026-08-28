import type {
  PaneHostNotice,
  PaneNavigationTarget,
  PaneUnavailableReason,
  WorkspacePaneHostContract,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import { type ReactNode, useCallback, useMemo } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { toastStore } from '../contexts/ToastContext';
import {
  presentPaneUnavailable,
  resolvePaneNavigationRoute,
} from './paneHostShellBindings';
import { usePaneConfirmChrome, usePaneHostFacts } from './paneHostShellChrome';

/**
 * D8's redirect notice and its banner id live with the shell bindings both
 * transports share now (`paneHostShellBindings.ts` — the reason→presentation
 * table). Re-exported here so this module's existing importers keep naming
 * the one sentence rather than acquiring a second path to it.
 */
export {
  BOARD_UNAVAILABLE_BANNER_ID,
  BOARD_UNAVAILABLE_NOTICE,
} from './paneHostShellBindings';

/** The identities the mounting placement binds for its occupant's intents. */
export interface InProcessPaneHostScope {
  /** The Project this pane occurrence is bound to, when it binds one. */
  projectSlug?: string;
  /**
   * Whether the mounter is CURRENTLY rendering its occupant and this host's
   * `confirmChrome`. Required, with no default -- see
   * `usePaneConfirmChrome`, which owns that lifetime rule for both
   * transports.
   */
  active: boolean;
}

export interface InProcessPaneHost {
  host: WorkspacePaneHostContract;
  /**
   * The shell's confirm chrome, rendered BY the placement (the design's
   * "the SHELL renders its own modal on the pane's behalf"). The pane only
   * ever sees `host.confirm(...)`'s promise; this element is how the
   * in-process transport actually shows the dialog, so the mounter must
   * render it alongside the pane.
   */
  confirmChrome: ReactNode;
}

/**
 * The in-process (tier 2) adapter for `WorkspacePaneHostContract`
 * (archive#4201, `docs/design/pane-host-contract.md` sequencing step 2): one
 * mapping from the contract's intents onto the shell's real capabilities —
 * the navigation store, the banner stack, the toast store, the shell's one
 * confirm chrome, and the single mobile derivation. The frame adapter (step
 * 3, `components/plugins/framePaneHost.tsx`) maps the same members onto
 * `PluginFrameHost` messages; a pane written against the contract cannot tell
 * the difference, which is the point.
 *
 * What this file is now, after the second transport landed: the TRANSPORT
 * half only. Where a target lands, what an unavailable reason presents, how
 * the confirm dialog behaves, what the device facts are — all of that is
 * shared with the frame adapter (`paneHostShellBindings.ts`,
 * `paneHostShellChrome.tsx`), because two adapters answering those questions
 * separately is the divergence the contract exists to end. This module owns
 * exactly one thing the frame adapter does differently: an intent here is a
 * direct call on the shell's own navigation seam, with no message, no
 * untrusted payload, and therefore no bound.
 */
export function useInProcessWorkspacePaneHost(
  scope: InProcessPaneHostScope,
): InProcessPaneHost {
  const { navigate } = useNavigation();
  const { projectSlug, active } = scope;

  const navigateTo = useCallback(
    (target: PaneNavigationTarget) => {
      const route = resolvePaneNavigationRoute(target);
      if (!route) return;
      navigate(route.pathname, route.params);
    },
    [navigate],
  );

  const notify = useCallback((notice: PaneHostNotice) => {
    // `tone` has one member today (`'info'`); the toast stack is its chrome.
    toastStore.show(notice.text);
  }, []);

  const presentUnavailable = useCallback(
    (reason: PaneUnavailableReason) => {
      // The pane owns the derivation; the shell owns the notice and where it
      // leaves for. An in-process pane is first-party code the shell mounted,
      // so the redirect is taken as given -- the frame adapter is where the
      // same intent has to be bounded.
      const redirect = presentPaneUnavailable(reason, projectSlug);
      if (redirect) navigateTo(redirect);
    },
    [navigateTo, projectSlug],
  );

  const { confirm, confirmChrome } = usePaneConfirmChrome(active);
  const facts = usePaneHostFacts();

  const host = useMemo<WorkspacePaneHostContract>(
    () => ({
      navigate: navigateTo,
      notify,
      presentUnavailable,
      confirm,
      facts,
    }),
    [navigateTo, notify, presentUnavailable, confirm, facts],
  );

  return { host, confirmChrome };
}
