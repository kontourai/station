import type {
  PaneHostFacts,
  PaneHostNotice,
  PaneNavigationTarget,
  PaneUnavailableReason,
  WorkspacePaneHostContract,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { toastStore } from '../../contexts/ToastContext';
import {
  presentPaneUnavailable,
  resolvePaneNavigationRoute,
} from '../../workspace-panes/paneHostShellBindings';
import {
  usePaneConfirmChrome,
  usePaneHostFacts,
} from '../../workspace-panes/paneHostShellChrome';
import {
  type PluginBudget,
  pluginConfirmBudget,
  pluginNavigationBudget,
  pluginToastBudget,
} from './plugin-frame-budget';
import { resolvePluginNavigationTarget } from './plugin-navigation-target';

/**
 * The frame (tier 3) adapter for `WorkspacePaneHostContract` (station#4201,
 * `docs/design/pane-host-contract.md` sequencing step 3).
 *
 * The design claims ONE interface serves both runtime tiers. Until this
 * module existed that claim rested on a single in-process implementation,
 * which proves nothing about a boundary; this is the second transport, and
 * what makes the claim falsifiable. The frame was already speaking two of the
 * contract's intents in message form — `toast` and `navigate`, added ad hoc
 * in station#3308 and station#3323 — so convergence here is recognising a
 * protocol, not inventing one: those two messages are now this adapter's
 * `notify` and `navigate`, absorbed rather than reimplemented beside it.
 *
 * ## What is the same, and what the transport adds
 *
 * The MEANING of every member is shared with the in-process adapter —
 * `paneHostShellBindings.ts` for where a target lands and what an unavailable
 * reason presents, `paneHostShellChrome.tsx` for the confirm dialog and the
 * device facts. A pane cannot tell which tier it is in, which is the point.
 *
 * What tier 3 adds is that the caller is UNTRUSTED. Three things follow, and
 * all three are the shell keeping what the design says is the shell's:
 *
 * 1. **Shape and origin are validated before anything is acted on.** The
 *    origin/WindowProxy pin lives at the listener in `PluginFrameHost`; the
 *    payload decoding lives here. A malformed request is refused, never
 *    coerced.
 * 2. **A message this adapter does not recognise is refused, not dropped.**
 *    Silence is how station#3308 and station#3323 both stayed broken for
 *    months: the capability was advertised and the message went nowhere, and
 *    nothing said so. Every refusal posts a `pane-host/refused` reply naming
 *    the method and the reason.
 * 3. **Budget stays shell-owned.** `notify` keeps the toast-flood refusal
 *    unchanged, `navigate` keeps its own, and `confirm` gains one, because a
 *    pane must not be able to spend more of the user's attention by being in
 *    a different tier.
 */

/** Every inbound method this adapter answers for lives under this prefix. */
export const PANE_HOST_METHOD_PREFIX = 'pane-host/';

export const PANE_HOST_INBOUND = {
  notify: 'pane-host/notify',
  navigate: 'pane-host/navigate',
  presentUnavailable: 'pane-host/present-unavailable',
  confirm: 'pane-host/confirm',
  facts: 'pane-host/facts',
} as const;

export const PANE_HOST_OUTBOUND = {
  confirmResult: 'pane-host/confirm-result',
  factsChanged: 'pane-host/facts-changed',
  refused: 'pane-host/refused',
} as const;

/**
 * The frame's two ORIGINAL capability messages, which are contract members
 * now. Kept as inbound spellings because `docs/guides/plugins.md` documents
 * them and installed plugins send them; they decode to `notify`/`navigate`
 * exactly as the namespaced forms do, through the same validation.
 */
export const PANE_HOST_LEGACY_INBOUND = {
  toast: 'toast',
  navigate: 'navigate',
} as const;

/** A structured-clone-safe message this adapter sends back to the frame. */
export type FramePaneHostOutboundMessage = {
  method: string;
  params: Record<string, unknown>;
};

/** The shell's navigation seam, as much of it as a pane host needs. */
export type PaneHostNavigate = (
  pathname: string,
  params: Record<string, string | null>,
) => void;

export interface FramePaneHostOptions {
  /**
   * Increments when the plugin frame's document is replaced. An outstanding
   * confirm belongs to the document that asked for it; see
   * `usePaneConfirmChrome`.
   */
  generation?: number;

  /** Attribution for chrome and the key every budget is metered on. */
  pluginName: string;
  /** The plugin's granted permissions, for the intents that require one. */
  granted?: readonly string[];
  /** The Project this frame occurrence is bound to, when it binds one. */
  projectSlug?: string;
  /** Whether the placement is currently rendering the pane and its chrome. */
  active: boolean;
  /** The shell's navigation seam, or `null` where the placement has none. */
  navigate: PaneHostNavigate | null;
  /** Deliver a message to the frame. Held in a ref; may change identity. */
  post: (message: FramePaneHostOutboundMessage) => void;
}

export interface FramePaneHost {
  /** The contract, implemented over this frame's transport. */
  host: WorkspacePaneHostContract;
  /** The shell's confirm chrome; the placement renders it beside the frame. */
  confirmChrome: ReactNode;
  /**
   * Marshal one inbound frame message onto the contract.
   *
   * Returns `true` when the message belonged to this adapter — whether it was
   * served or refused — so the caller's remaining lifecycle cases (`ready`,
   * `initialize`, `fill`) can be left alone, and so "belonged to us but was
   * invalid" can never read as "was not ours".
   */
  receive: (message: unknown) => boolean;
}

const PLUGIN_TOAST_MAX_CHARS = 300;
const PLUGIN_CONFIRM_MAX_CHARS = 300;

/**
 * A refusal is silent to the plugin author (the message bridge was one-way
 * for these intents) and to the user (nothing renders), which makes a
 * rate-limited plugin look broken rather than throttled. Report it once per
 * refill interval — reporting every refusal would let the looping plugin turn
 * the report into the flood.
 */
export function reportRefusal(
  budget: PluginBudget,
  pluginName: string,
  capability: string,
  now: number,
  options?: { userMessage?: string },
) {
  if (!budget.shouldReport(pluginName, now)) return;
  console.warn(
    `[plugins] "${pluginName}" is over its ${capability} rate; further requests are being dropped.`,
  );
  // A refused NAVIGATION or CONFIRM on a legitimate third click is a
  // user-visible nothing — the silent no-op #3323 exists to fix, reintroduced
  // for the honest case — so its refusal surfaces as a toast (host-issued: it
  // spends no plugin token, and `shouldReport` bounds it to once per
  // interval). Toast refusals stay console-only on purpose: their refusal
  // reason is a toast flood, and answering a flood with one more toast feeds
  // it.
  if (options?.userMessage) toastStore.show(options.userMessage);
}

function readParams(message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null) return null;
  const params = (message as { params?: unknown }).params;
  if (params === undefined) return {};
  if (typeof params !== 'object' || params === null) return null;
  return params as Record<string, unknown>;
}

/** Non-empty display text, bounded — a frame does not size shell chrome. */
function readText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxChars);
}

export function useFramePaneHost(options: FramePaneHostOptions): FramePaneHost {
  const { pluginName, granted, projectSlug, active } = options;

  // Both collaborators are held in refs rather than read from the closure:
  // this hook's `receive` is what the placement's ONE message listener is
  // built from, so an identity change here re-subscribes that listener and
  // drops messages in flight. The provider hands back a new navigation object
  // every render, and the placement's `post` is bound to a frame that can be
  // replaced — neither is a reason to rebuild the bridge.
  //
  // Written in effects, not in the render body: a render can be thrown away
  // or replayed, and a ref write is exactly the side effect that must not
  // happen then.
  const postRef = useRef(options.post);
  useEffect(() => {
    postRef.current = options.post;
  }, [options.post]);
  const post = useCallback((message: FramePaneHostOutboundMessage) => {
    postRef.current(message);
  }, []);

  const refuse = useCallback(
    (method: string, reason: string, id?: unknown) => {
      post({
        method: PANE_HOST_OUTBOUND.refused,
        params: {
          method,
          reason,
          ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
        },
      });
    },
    [post],
  );

  const navigateRef = useRef<PaneHostNavigate | null>(options.navigate);
  useEffect(() => {
    navigateRef.current = options.navigate;
  }, [options.navigate]);

  const facts = usePaneHostFacts();
  const { confirm: confirmChromeRequest, confirmChrome } = usePaneConfirmChrome(
    active,
    // The frame document is torn down and rebuilt while this placement stays
    // mounted, so it is a lifetime neither `active` nor unmount can see.
    options.generation,
  );

  const notify = useCallback(
    (notice: PaneHostNotice) => {
      const now = Date.now();
      if (!pluginToastBudget.claim(pluginName, now)) {
        reportRefusal(pluginToastBudget, pluginName, 'toast', now);
        refuse('notify', 'rate-limited');
        return;
      }
      // station#3308: the old `station-plugin-toast` CustomEvent had no
      // listener anywhere — the advertised toast capability silently did
      // nothing. Route straight into the ToastStore, attributed to the
      // plugin so a frame cannot impersonate Station chrome messages.
      toastStore.show(
        `${pluginName}: ${notice.text.slice(0, PLUGIN_TOAST_MAX_CHARS)}`,
      );
    },
    [pluginName, refuse],
  );

  const navigateTo = useCallback(
    (target: PaneNavigationTarget) => {
      // PERMISSION TIER: `navigation.dock` is `passive` in
      // `src-server/services/plugins/plugin-permissions.ts`, which means
      // auto-granted at install with no consent prompt. That was harmless
      // while this bridge was dead. It is not harmless now, and the tier
      // deserves a decision this change does not make — the bound below is
      // what keeps an unconsented grant from becoming a shell the user
      // cannot steer.
      if (!granted?.includes('navigation.dock')) {
        refuse('navigate', 'permission-required');
        return;
      }
      const route = resolvePaneNavigationRoute(target);
      const navigate = navigateRef.current;
      if (!route) {
        refuse('navigate', 'unresolvable-target');
        return;
      }
      if (!navigate) {
        refuse('navigate', 'no-navigation-host');
        return;
      }
      const now = Date.now();
      if (!pluginNavigationBudget.claim(pluginName, now)) {
        reportRefusal(pluginNavigationBudget, pluginName, 'navigation', now, {
          userMessage: `${pluginName}: navigation was ignored — too many requests in a row.`,
        });
        refuse('navigate', 'rate-limited');
        return;
      }
      // DELIBERATE EXCEPTION to the repo rule that project-layout navigation
      // goes through `setLayout`. That rule exists so `/` restores the user's
      // last-viewed layout — and a plugin frame is not the user. `setLayout`
      // writes `lastProject`/`lastProjectLayout` to localStorage
      // unconditionally (`navigation-store.ts`), so routing this through it
      // let a plugin repoint what the app restores to on every future launch,
      // outliving the plugin's own removal. Recording a frame's choice as the
      // user's is a false attribution before it is a security hole. The shell
      // still goes exactly where `setLayout` would have sent it; only the
      // persistence is withheld. (The File Preview fields `setLayout` would
      // have cleared are cleared by the shared route resolver instead — see
      // its project-layout case.)
      navigate(route.pathname, route.params);
    },
    [granted, pluginName, refuse],
  );

  const presentUnavailable = useCallback(
    (reason: PaneUnavailableReason) => {
      // NOT REACHABLE from `PluginFrameHost` today, and deliberately not
      // faked into looking reachable: that placement binds no Project, so
      // `presentPaneUnavailable` returns null and this is a no-op — exactly
      // what the in-process adapter does for an unbound pane. The member is
      // implemented rather than stubbed or omitted because a transport that
      // drops a contract member has forked the contract; a placement that
      // binds a project gets the behaviour by passing `projectSlug`, with
      // the bound below already in force.
      //
      // Reaches the same reason→presentation table the in-process adapter
      // uses, and then the same bounded navigation: an unavailable redirect
      // is a navigation, so a frame must not be able to move the shell
      // through it more often than `navigate` allows.
      const redirect = presentPaneUnavailable(reason, projectSlug);
      if (!redirect) {
        refuse('present-unavailable', 'no-bound-project');
        return;
      }
      navigateTo(redirect);
    },
    [navigateTo, projectSlug, refuse],
  );

  const confirm = useCallback<WorkspacePaneHostContract['confirm']>(
    (request) => {
      const now = Date.now();
      // Interrupting the user needs the user's own yes. The shell's confirm
      // chrome is a focus-trapping full-viewport overlay wearing Station's
      // authority, above Station's own buttons, and the plugin writes the
      // body text — so an unconsented plugin must not be able to raise it at
      // all. The budget bounds the RATE, which was never the concern here:
      // the first dialog is the one that steals the keystroke.
      if (!granted?.includes('ui.confirm')) {
        refuse('confirm', 'permission-required');
        return Promise.resolve('cancelled' as const);
      }
      if (!pluginConfirmBudget.claim(pluginName, now)) {
        reportRefusal(pluginConfirmBudget, pluginName, 'confirmation', now, {
          userMessage: `${pluginName}: a confirmation was ignored — too many requests in a row.`,
        });
        // The contract promises this promise never rejects and always
        // settles with a decision. Nothing was confirmed.
        return Promise.resolve('cancelled' as const);
      }
      return confirmChromeRequest({
        title: `${pluginName}: ${request.title}`,
        message: request.message,
      });
    },
    [confirmChromeRequest, granted, pluginName, refuse],
  );

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

  // One live facts subscription per frame, taken out when the frame asks and
  // released when this adapter goes away. In-process the pane holds its own
  // subscription; here the adapter holds it on the pane's behalf and forwards
  // each push as a message, so `isMobile` flipping reaches the frame without
  // the pane's code knowing the difference.
  const factsUnsubscribeRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      factsUnsubscribeRef.current?.();
      factsUnsubscribeRef.current = null;
    },
    [],
  );

  const subscribeFacts = useCallback(() => {
    factsUnsubscribeRef.current?.();
    const send = (value: PaneHostFacts) => {
      post({
        method: PANE_HOST_OUTBOUND.factsChanged,
        params: { facts: value },
      });
    };
    factsUnsubscribeRef.current = facts.subscribe(send);
    send(facts.read());
  }, [facts, post]);

  const receive = useCallback(
    (message: unknown): boolean => {
      if (typeof message !== 'object' || message === null) return false;
      const method = (message as { method?: unknown }).method;
      if (typeof method !== 'string') return false;
      const isPaneHostMethod = method.startsWith(PANE_HOST_METHOD_PREFIX);
      const isLegacy =
        method === PANE_HOST_LEGACY_INBOUND.toast ||
        method === PANE_HOST_LEGACY_INBOUND.navigate;
      if (!isPaneHostMethod && !isLegacy) return false;

      const params = readParams(message);
      if (!params) {
        refuse(method, 'params must be an object');
        return true;
      }

      switch (method) {
        case PANE_HOST_LEGACY_INBOUND.toast:
        case PANE_HOST_INBOUND.notify: {
          // The legacy message spells the text `message`; the contract spells
          // it `text`. One decode, either spelling, one `notify` call.
          const text =
            readText(params.text, PLUGIN_TOAST_MAX_CHARS) ??
            readText(params.message, PLUGIN_TOAST_MAX_CHARS);
          if (!text) {
            refuse(method, 'notice text must be a non-empty string');
            return true;
          }
          host.notify({ text, tone: 'info' });
          return true;
        }
        case PANE_HOST_LEGACY_INBOUND.navigate:
        case PANE_HOST_INBOUND.navigate: {
          const target = resolvePluginNavigationTarget(params.target);
          if (!target) {
            refuse(method, 'navigation target is not allowed');
            return true;
          }
          host.navigate(target);
          return true;
        }
        case PANE_HOST_INBOUND.presentUnavailable: {
          // The reason vocabulary is closed and small; an unrecognised one is
          // refused rather than presented as some default sentence.
          if (params.reason !== 'no-builder-run') {
            refuse(method, 'unavailable reason is not recognised');
            return true;
          }
          host.presentUnavailable(params.reason);
          return true;
        }
        case PANE_HOST_INBOUND.confirm: {
          const id = params.id;
          if (typeof id !== 'string' && typeof id !== 'number') {
            refuse(method, 'confirm request needs an id to answer');
            return true;
          }
          const title = readText(params.title, PLUGIN_CONFIRM_MAX_CHARS);
          const confirmMessage = readText(
            params.message,
            PLUGIN_CONFIRM_MAX_CHARS,
          );
          if (!title || !confirmMessage) {
            refuse(method, 'confirm needs a title and a message', id);
            return true;
          }
          void host.confirm({ title, message: confirmMessage }).then(
            (decision) => {
              post({
                method: PANE_HOST_OUTBOUND.confirmResult,
                params: { id, decision },
              });
            },
            // Unreachable by contract — `confirm` never rejects — but a
            // transport that silently swallowed a rejection would leave the
            // frame waiting forever, so the settle is written down rather
            // than assumed.
            () => {
              post({
                method: PANE_HOST_OUTBOUND.confirmResult,
                params: { id, decision: 'cancelled' },
              });
            },
          );
          return true;
        }
        case PANE_HOST_INBOUND.facts: {
          subscribeFacts();
          return true;
        }
        default: {
          refuse(method, 'method is not a pane-host capability');
          return true;
        }
      }
    },
    [host, post, refuse, subscribeFacts],
  );

  // `refuse` is deliberately NOT returned. It was exposed for the one uplink
  // message the placement decoded itself — `api-request`, deleted in
  // station#4300 — and every refusal now originates inside this adapter. A
  // second caller posting `pane-host/refused` on its own terms is how
  // "refused" comes to mean two things.
  return { host, confirmChrome, receive };
}
