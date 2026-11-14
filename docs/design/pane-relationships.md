# Pane relationships

Status: accepted implementation contract, 2026-10-19. Delivery and evidence are
tracked in [the implementation plan](../plans/pane-workspace.md). This document
describes the target behavior; an unchecked acceptance item is not shipped.

Station has one workspace sidebar and three default content areas: Main,
Related on the right, and Tools below. Left remains an advanced placement in
Layout and pane controls. Saved arrangements and explicit plugin placements
remain readable. Chat's inbox belongs inside its surface.
Related and Tools are shell siblings of Main.

## Relationship and placement

A destination opens beside its source on desktop and as a child screen on a
phone. A selection inspector follows its source, unless locked, and becomes a
sheet on a phone. Editors, conversations and terminals are ongoing work: their
captured context and state survive hiding. Position, UI opener and domain Task,
Session or run ancestry are independent facts.

One transient preview is reusable per exact opener selection. Keep and beginning
an edit protect it. Opening an exact kept target focuses it. Target identity
includes Station, Project, path and thread where applicable.

Changing source hides its transient child and returning restores it. Kept work
stays reachable with its captured scope visible. Replacement, close and source
changes run the relevant unsaved guard before committing. Cancel changes neither
source, child nor focus. Region buttons only show or hide existing content.

Back consumes real history. Up returns to the exact opener; when its own
reveal would take the child off screen (a phone layer, or the child's region
tab), the child's guard is asked once first. A cold child link
does not fabricate a parent history entry. Reload restores the exact validated
child. Resizing changes presentation without creating history or controllers.
Loading, offline, missing, denied and wrong-Station outcomes remain distinct.

### Child transcripts in Chat

Activity Quick review is retired. A child transcript opens in the chat pane
using the shared message renderer. Each chat pane keeps its own ancestor stack;
choosing a breadcrumb, Back, or Escape returns to the parent reader. The parent
stays mounted, preserving its draft and scroll state. Engine child records are
read only and use the owning Station's transcript query, refreshing while running.
Delegates read their own Session thread with the same conversation reader.

Legacy Activity URLs open their named Session in Chat, or the inbox without a
Session. Home and the inbox supply the work list; no Activity list selection,
filters, sibling Previous/Next traversal or Quick review pane remains.

## Persistence and authority

The existing arrangement owns position and tab order. A bounded, versioned side
record associates occurrence/stateKey with Station identity, installation
generation, opener selection, target identity and Keep. Readers reject invalid
references, cycles, oversized records and mismatched Station/generation. Old
arrangements remain readable; unsupported metadata cannot erase kept work.

Each related occurrence also carries its own Station fence, written once when it
is minted and removed only with the occurrence: only once the occurrence's own
record is confirmed gone, so a record whose removal failed stays fenced rather
than reading as an unfenced legacy occurrence. A gate outside the pane admits
its reader only on exactly that verified Station: while the Station is unknown
it reads nothing, on another Station it shows a placeholder, and a fence this
build cannot read stays closed. Losing, rolling back or outgrowing the side
record therefore never unfences an occurrence.

Writes to the side record are transactions under an exclusive cross-window
lock, over a fresh read of the record. Focusing an existing target writes too
(its arrangement and a new line range), so it commits the same way. A
contended or unavailable lock, a newer record, the bound, or a Station, source,
target or covered pane that changed while a guard was answering — the panes
the model's own plan for the open takes off screen, read from its committed
arrangement (on a phone, the pane a first related pane folds over in Chat's
region), and including a pane that gained unsaved work meanwhile — refuses
the open, and a refusal removes whatever it had written. At
the bound a new relation is refused; nothing live or kept is evicted, and only
relations whose occurrence no longer exists in shared storage are pruned.

Without a verified Station there is nothing to fence a new occurrence to, so a
related open is refused, says so, and writes nothing. Previews made before
relationships keep their unfenced reads; no new unfenced one is minted, and an
occurrence that was ever fenced is never matched or read by path.

Relations describe display and navigation only. They never authorize a read,
grant plugin context, broaden a bound occurrence or establish domain ancestry.

## Coding and shared presentation

Coding retains its original host, occurrence, React/SDK/guard context, storage
lease and navigation. An exclusive presentation lease puts that host's content
into stable shell Related/Tools outlets. Ambient arrangements are suspended and
restored, not rewritten. Switching owners is guarded. Independent kept panes
remain reachable. A portal must not change its target during responsive folds.

One Chat controller and one Terminal owner may exist across the Coding and
ambient hosts. The fixed `workspace-coding-terminal` instance/stateKey remains
Project-bound. Process identity must be observed, not inferred from equal keys.
Coding's existing panel writer owns toggles and, initially, per-session sizes;
the shell delegates through an adapter rather than writing a second record.
The fold derives once. Phones gain an inbox/conversation root before Coding
children. The default Files placement moves from Left; explicit placement stays.

## SDK and plugins

An optional versioned occurrence-bound host capability provides request/response
open, reveal and close in both trusted direct and sandboxed iframe transports.
Plugins name their own registered descriptor/mode and a bounded opaque target.
The host stamps the opener, exact Station, captured context and generation,
checks mode requirements and current grants, then selects beside/child/sheet/tool
presentation. Results distinguish opened, focused, replaced and unavailable,
including unsupported, context mismatch and guard cancellation.

Direct plugins remain trusted in-process code. The iframe transport bounds the
related-pane message API; it does not qualify isolation from the native app.
Native plugin frames remain unqualified for protection of app data, native
features and saved Station credentials, as the loading review discloses.
Admission, budgets and refusal semantics agree across transports.
Legacy navigation remains available. No raw URL, React slot, arbitrary Session
identity or filesystem/process authority crosses the new capability. Declaring
`docked` is not region admission. Dogfood a plugin-owned report first; built-in
file/terminal requests require separately closed, permission-gated targets.
Plugin disable changes its generation and yields an unavailable placeholder;
Session-owned tools have an independent lifecycle. Older hosts disclose the
unsupported action without opening an empty pane. Inspector selection facts are
proved with built-in Session properties before extending plugins.

### Returning to a Project plugin pane

A related open from a direct Project pane captures that pane's catalog-issued
descriptor and instance IDs in its typed opener record. Up builds the return
through `workspacePaneDirectRoute`; the Project overview is not a substitute.
The metadata contains no raw URL and grants no context or permission. The route
owner still resolves the pane and admits its current renderer.

The record survives reload. A routed return uses canonical navigation precommit
and rechecks the Station and captured relation after guards answer. A phone
child already on its opener's route uses the existing layer's scoped guard once
before returning; Cancel leaves history, placement, state and focus unchanged.
A replacement layer, new owner guard or withdrawn caller admission supersedes
that close. Same-path Up adds no history; desktop Up already at its opener is
a no-op. Back's caption uses any verified relation's captured opener label,
including Files, routes, plugins and conversations.
An older record without that reference gains it only when the same exact
Project-pane caller reopens its target. After guards answer, the existing lock
rechecks the caller's Station, Project, installed generation, occurrence, target
state and fence, and the unchanged source record before adding the missing
reference. Other openers and existing references are never rewritten. Until
that caller witnesses it, the old record retains its truthful layout or Project
fallback; missing identity is never guessed from ambient context. The optional
reference does not change preview selection identity: an unkept old preview
still focuses for the same target and replaces for another. References outside
the relation reader's bounds are omitted before stamping or attestation, so the
legacy return remains readable rather than losing its relation on the next read.

## Shell controls

Keep the current header styling. Existing icon-only Tools and Related buttons
move to the far right. Left is reachable through advanced Layout/pane controls.
The account menu sits at the right of the sidebar footer, immediately after the
icon-only Updates button, including collapsed and mobile access. Schedule and
Customize sit on the left; Settings remains reachable through the account menu
and Customize. Live work no longer appears in the footer. Its mobile overflow
entry remains available while the drawer is closed. Counts describe paired-device
participants, not people. Pressed states reflect the active owner's real state.
