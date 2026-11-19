# UI scope

Read [the module map](../docs/architecture/module-map.md) and the relevant design document before changing a surface. Keep UI state and navigation contract-driven; use canonical state primitives and the unsaved-changes guard where a view owns dirty state. Do not introduce a product claim the backing runtime cannot prove.

Use React Query for remote data fetching through the existing SDK query hooks; do not add bespoke fetch lifecycle state. Before deriving a count, status, eligibility rule or label, reuse its contract field or shared selector, and name any filtered or actionable subset explicitly. Project layout navigation must flow through canonical `setLayout`; a Project entry without a layout uses canonical `setProject`. Do not mutate local routes to bypass either seam. `useUnsavedGuard` registers dirty state with the navigation store: call canonical `navigate` directly for route changes, and reserve its explicit `guard` callback for local state changes. Wrapping a registered route in that same guard asks twice and can lose the pending action.

Cover changed user-visible behavior at the narrowest appropriate layer.

## Conversation boundaries

Read [Station connections](../docs/design/station-connection.md) before changing
a conversation surface or controller. The connection/controller owns the target;
a surface never derives host authority. Snapshots, outbox rows and query/state
keys carry Station identity and authority. Resolve capabilities at that boundary
and consume `ConversationCapabilities` or explicit ports in shared controls.

Use `components/conversation/ConversationBody.tsx` for the body,
`components/chat/ChatInputArea.tsx` for replies and
`components/chat-start/StartComposer.tsx` for initial drafts. Sends use the bound
`components/conversation/conversation-transport.ts` and durable send controller;
Stop uses `components/conversation/ConversationStopControl.tsx`, approvals use
`components/conversation/useApprovalAnswering.ts`, delivery uses
`components/chat/message-bubble/MessageDeliveryNote.tsx`, and failures use
`utils/stationFailure.ts` (composed with the provider-domain translator).

Register adapters and required owner consumption in
`scripts/conversation-surfaces.json`, including its failure publishers. History and
Inbox owners are active. Exact fingerprint contracts describe host-shell/domain
adapters and diagnostic disclosures; they do not exempt new conversation code.
Run `npm run gate:for -- <paths>` and
`node scripts/conversation-boundary-gate.mjs`. Its G1–G5 scanner only proves
structural rules: keep real consumer/action and two-Station isolation tests.
The syntax/file baseline may only shrink with `--update`; never add an exception
for a new surface or move inherited debt to another filename.

For performance and test cleanup, use the [journey profiling and mutation route](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness). Measure mounted behavior before memoizing or caching. Use canonical identity keys, bounded collections and batched I/O. Preserve snapshot authority and freshness. DOM/source-string assertions cannot prove CSS layout, hit testing or writability.

Reuse `.choice-trigger`, `.choice-caret` and `ArrowDownGlyph` for compact pickers. Keep picker behavior in its owner. `ResponsiveDialogSurface` supplies behavior and geometry. Consumers own overlay, background and foreground styles. Preserve visible keyboard focus and 44px mobile targets. Check every affected caller at narrow widths and in both themes.

Before writing feature CSS, find a shipped caller and review `@kontourai/ui/react` and the [shared presentation recipes](../docs/patterns/frontend.md#styling-and-responsive-behavior). Use `ActionRow` for commands with one primary, `Field`/`Select` for form choices, `StatusSummary` for identity, status and check metadata, and `content-stack` for semantic flow.

In framed shell routes, `PageFrame` owns gutters, `PageSection` owns titled sections, and `PageRow` owns label/description/control rows. Parents own child gaps. Controls own type, padding and states. Keep feature geometry local. Change the common owner and remove matching overrides together.

| Conversation surface | Shared owner |
| --- | --- |
| Dock, attached session, coding tab | `components/conversation/ConversationBody` |
| Reply and exact needs-input draft | `components/chat/ChatInputArea`; exact adapters retain request identity |
| Owner, member and guest Task history | `components/conversation/SharedTaskHistoryList` |
| Desktop and mobile Inbox | `components/chat-dock/useInboxPanelController` |
| Request failure and durable error publisher | `utils/stationFailure`; provider policy stays in `utils/chatErrorTranslation` |

## UI definition of done

Applies to `src-ui`, `packages/basis-pane` and `packages/board-pane`.

- Render loading, empty, error with retry/refetch, and partial (failed or pending reads) states.
- Render at 390px and 1440px in both themes. Inspect the PNGs at native size for clipped values, uneven insets and crowded actions. Check keyboard focus in context.
- Use these owners. Pane packages import published packages (`@kontourai/station-sdk` and its subpaths, `@kontourai/ui/react`, `@kontourai/station-contracts`), never `src-ui` modules.

| Pattern | Shell (`src-ui`) | Pane packages |
| --- | --- | --- |
| Standard action | `Button` (`components/Button`) | `ActionControl` from `@kontourai/station-sdk/action-control`; not the SDK barrel `Button`, which defaults to `type="submit"` |
| Error with retry | `ErrorState` (`components/state`) with an `action`; `variant="compact"` inline | `ErrorState` from `@kontourai/station-sdk/error-state`, same props |
| Empty | `Empty`; `FilteredEmpty` when a filter hides results | `Empty` from `@kontourai/ui/react` (shell-only `FilteredEmpty`: give `Empty` a clear-filter action) |
| Loading | `SkeletonList` (rows), `SkeletonBlock` (region); a conversation's first load uses `ConversationLoadingStage` | `Skeleton` from `@kontourai/ui/react` |
| Status pill or badge | `StatusBadge` or `Badge` from `@kontourai/ui/react`, not the SDK `Pill` | Same |
| Dialog | `Dialog`; `ConfirmModal` for a confirmation | `host.confirm(...)` for a confirmation; no pane dialog owner yet, so ask before adding one |
| Disclosure | `DisclosureToggle` for a folded list section | No published primitive; a native `button` with `aria-expanded` |
| Key/value, table | No primitive; semantic `dl`/`table` with `--k-*` tokens | Same |

`npm run lint:component-style` flags new literal font sizes, padding and gaps in CSS and direct JSX styles. Check the shared owner. It also rejects `role="alert"` elements with their own button. Use `ErrorState`.

Layout, touch targets and dialogs: [responsive UI](../docs/guides/responsive-ui.md). Data ownership, tones and styling: [frontend patterns](../docs/patterns/frontend.md).

## Product copy

See the [UI copy guide](../docs/guides/ui-copy.md) and [glossary](../docs/glossary.md#user-facing-labels).

- Outcome first, in the user's nouns, plus at most one next action. State each fact once; show status as a badge, not a sentence. Aim for at most 100 characters per description.
- No internal vocabulary (authority, receipt, durable, reconcile, legacy, …) or issue numbers. No defensive negations: say what is true, and put detail in a Details disclosure.
- Don't repeat what is on screen: no restating subtitles or hints, no `title` equal to the visible text. Sentence case, `…`, no filler.
- Run `npm run ui-copy-length:ratchet` and `npm run ui-copy-style:ratchet` (`npm run ui-css-slop:ratchet` for CSS). Fix a failure by rewriting; regenerate a baseline with `--update` only for shrinkage or a reviewed exception.

## Design system

See [DESIGN.md](https://github.com/kontourai/ui/blob/main/DESIGN.md) for UI, brand and copy rules (`node_modules/@kontourai/ui/DESIGN.md`). Inherit component typography or use `--k-text-*`. Station’s `--k-text-sm` follows Comfortable/Compact. Use kit color, radius and `--k-space-*` tokens. Check computed values when migrating: `--space-2` is 4px, `--k-space-2` is 8px. Leave OPEN decisions with their owners.
