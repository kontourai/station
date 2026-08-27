/**
 * The pane-host contract (station#4201, `docs/design/pane-host-contract.md`):
 * what any host owes any Workspace Pane occupant, independent of transport.
 * A pane written against this interface runs in either runtime tier — direct
 * calls in-process (tier 2), request/response messages across the iframe
 * boundary (tier 3) — because every parameter and result here is
 * structured-clone-safe BY TYPE: no functions, no components, no class
 * instances in any payload. The `facts.subscribe` listener is contract
 * mechanics, not payload — in-process it is a callback, across the frame the
 * adapter maps it onto pushed messages.
 *
 * What ENFORCES that, precisely, so the claim is not larger than its
 * derivation: the tripwire test proves this module imports nothing and that
 * no renderer token appears in it. Neither assertion would reject a payload
 * typed `Date`, `Map` or `() => void` — all clone-unsafe or clone-lossy, all
 * expressible here. The clone-safety of the payload TYPES is reviewed, not
 * computed; only the component ban is mechanical. Adding a member whose
 * payload is not a plain-data type is a review failure, not a test failure.
 *
 * Members are RECEIVER-INDEPENDENT: an implementation may not depend on
 * `this`. Call sites are free to destructure or pass a member on its own
 * (`host.facts.subscribe` is passed unbound today), so an implementation
 * built from a class with `this`-bound methods would break at those call
 * sites while satisfying the type. Build hosts from closures.
 *
 * Two rules from the design, load-bearing here:
 *
 * 1. **Components never cross the contract.** A capability is an intent, a
 *    fact, or a published package. The moment a member of this interface
 *    grows a `ComponentType`, the tier-2 contract has silently forked from
 *    tier 3 — that regression tripwire is pinned as a test
 *    (`__tests__/workspace-pane-host-contract.test.ts`: this module imports
 *    nothing, react least of all).
 * 2. **Placement concerns stay with the placement.** Headers, banners and
 *    redirect chrome belong to the mounter that placed the pane; this
 *    contract carries only the intents a pane may raise and the environment
 *    facts a host owes it.
 *
 * Not to be confused with `./workspace-pane-host.ts`, which despite the near
 * -identical name is a different concept entirely: that module is the pane
 * LAYOUT document (splits, tab groups, `WorkspacePaneHostScope`). This one is
 * the shell CAPABILITY interface. Both are re-exported from the same barrel.
 *
 * Vocabulary types are defined narrowly from the real call sites (today: the
 * Board pane and the plugin frame's toast). A pane needing a capability or a
 * vocabulary member not listed here files it; the design's categories decide
 * its shape. This module deliberately has no imports: nothing here may
 * depend on a renderer, a store, or a transport.
 */

/**
 * Where a pane may ask the shell to go.
 *
 * Every member names a DESTINATION the shell knows how to reach, never a
 * path: the shell owns the path grammar (one derivation, shared by both
 * adapters), so a pane cannot construct a destination the product does not
 * itself navigate to. There is deliberately no `{ kind: 'raw-path'; path }`
 * member — a member that accepts any string path is this union not existing,
 * and across the frame boundary it is an untrusted string steering the shell.
 *
 * The frame transport's two real targets joined here in design sequencing
 * step 3 (station#4201's frame adapter), which is what the earlier "not
 * before" note was waiting for:
 *
 * - `project-layout` is the frame's `/projects/<project>/layouts/<layout>`
 *   request, typed by its two slugs instead of by its shape.
 * - `app-surface` is the frame's "a path the app's own surface registry
 *   resolves to a view" request, typed by the surface's REGISTRY ID. The id
 *   is a string because this module may not import the shell's registry, but
 *   its vocabulary is closed and shell-owned: the adapter refuses an id the
 *   registry does not know, and the route comes from the registry rather than
 *   from the message, so traversals, queries, fragments and absolute URLs are
 *   unrepresentable rather than filtered.
 */
export type PaneNavigationTarget =
  | {
      kind: 'project-workspace';
      projectSlug: string;
      /** Land on this recovered task inside the workspace, when known. */
      taskSlug?: string;
    }
  | {
      kind: 'project-layout';
      projectSlug: string;
      layoutSlug: string;
    }
  | {
      /** A surface id from the shell's own registry — never a path. */
      kind: 'app-surface';
      surfaceId: string;
    };

/**
 * How a notice reads. One member today: the only live notify caller (the
 * plugin frame's toast message) carries no tone, so nothing derives a second
 * one yet. A new tone joins when shell chrome actually distinguishes it —
 * a tone the shell renders identically to `info` would be a label nothing
 * derives.
 */
export type NoticeTone = 'info';

/**
 * Why a pane cannot be shown. The reason is a derivation the PANE owns (for
 * `no-builder-run`: the server said it knows no Builder run for this
 * project); what the shell does about it — the redirect, the notice sentence
 * — is the host adapter's, so the pane never carries shell copy.
 */
export type PaneUnavailableReason = 'no-builder-run';

/** The user's answer to a {@link WorkspacePaneHostContract.confirm} request. */
export type PaneConfirmDecision = 'confirmed' | 'cancelled';

/**
 * A confirm request's payload — plain data; the SHELL renders the modal.
 *
 * Deliberately carries no severity/variant member. `ConfirmModal` does render
 * `variant: 'danger'` and `role="alertdialog"` differently, so a member here
 * would not be a label nothing derives — but it would let the OCCUPANT choose
 * how loudly the shell interrupts its own user, and across the frame boundary
 * that occupant is untrusted bytes. Attention is shell-owned for the same
 * reason the notify budget is (`docs/design/pane-host-contract.md`: "the shell
 * owns budget and chrome"), and no caller derives a severity today. If a pane
 * ever needs the distinction, the shell should derive it from something it
 * itself knows about the request, not accept it as a claim.
 */
export interface PaneConfirmRequest {
  title: string;
  message: string;
}

/** A notice's payload — plain data; budget/refusal rules stay shell-owned. */
export interface PaneHostNotice {
  text: string;
  tone: NoticeTone;
}

/**
 * Environment facts a host owes its occupant. Later members (theme, locale)
 * join HERE, never as new ad-hoc messages — one subscribable value, pushed
 * on change across the frame, a context read in-process.
 */
export interface PaneHostFacts {
  device: {
    /** The shell's single phone/coarse-pointer derivation. */
    isMobile: boolean;
  };
}

/**
 * The one host interface, both transports. See the module docblock; member
 * semantics follow the design's capability table.
 */
export interface WorkspacePaneHostContract {
  /** Intent: take the user somewhere the shell itself navigates to. */
  navigate(target: PaneNavigationTarget): void;
  /** Intent: show a transient notice; the shell owns budget and chrome. */
  notify(notice: PaneHostNotice): void;
  /**
   * Intent: this pane has derived that it cannot be shown. The shell owns
   * the redirect and the notice that travels with it.
   */
  presentUnavailable(reason: PaneUnavailableReason): void;
  /**
   * Request/response intent: the shell renders ITS confirm chrome on the
   * pane's behalf and resolves with the user's decision. The pane never
   * receives a component, so the semantics survive the frame boundary
   * unchanged.
   *
   * **This promise never rejects.** Every outcome is a decision: the user
   * answers, or the request is settled `cancelled` — superseded by a newer
   * request, outlived by the pane, refused by the host's own bound. A call
   * site therefore needs no `.catch`, and `void host.confirm(...).then(...)`
   * is correct rather than an unhandled rejection waiting for the second
   * transport. The alternative — "it may reject, and every call site handles
   * it" — was rejected because it puts a transport's failure vocabulary in
   * every pane, and because `cancelled` is already the only safe reading of a
   * request nothing can answer: nothing was confirmed.
   */
  confirm(request: PaneConfirmRequest): Promise<PaneConfirmDecision>;
  facts: {
    read(): PaneHostFacts;
    /** Returns the unsubscribe function. */
    subscribe(listener: (facts: PaneHostFacts) => void): () => void;
  };
}
