# Workspace map implementation evidence

The accepted Quiet tree direction is implemented in source through
`7743a0400d56eac0d349c462cb13f354769ca8fb`, compared with
`777d9502ad8aedbbff2047a753550d8bece0ce01`. Later commits in this lane record
review notes and screenshots. These observations are local evidence, not
hosted, native-device, release, or merge qualification.

## Behavior

The desktop map is 216px expanded and 52px collapsed. The selected project's
configured Layouts form a vertical list with one roving tab stop. Personal
Boards follow Projects. A collapsed project opens its actual views without
navigating first. The footer stays in one row; its collapsed utilities popup
keeps live work, Schedule, Customize and Settings reachable. The header keeps
its Layout picker, project breadcrumb, notifications, account, Station and
region controls, and adds the desktop map toggle. Mobile keeps its drawer.

The former Open chats/Drafts sidebar sections and their obsolete Appearance
controls are removed. Chat/draft storage and the dock inbox are unchanged.
The retired sidebar file-intake browser fixture is removed with its only
production surface; composer and chat-pane file-drop owners remain.

## Screenshots

Both apps ran from separate checkouts and temporary homes, using ordinary
Chrome interactions to create an empty Station project with Coding and Tasks
Layouts. No Agent was dispatched. The before captures use exact base
`777d9502ad8`; after captures use reviewed UI source `7743a0400d5` (documentation
HEAD `e1b6655d22f`). Data and connection state are sample-instance observations.
The after header's saved Default Station reports Reconnecting; this capture
does not qualify remote connectivity or any provider.

| State | Before | After |
| --- | --- | --- |
| Expanded | [Base expanded](before-expanded.png) | [Quiet tree expanded](workspace-map-expanded.png) |
| Collapsed | [Base rail](before-collapsed.png) | [Project rail](workspace-map-collapsed.png) |
| Project views | Not offered in the base rail | [Click-open views](workspace-map-project-menu.png) |
| Footer | Separate rail controls | [Utilities popup](workspace-map-utilities.png) |
| Phone | Not recaptured | [390px drawer](workspace-map-mobile.png) |

The phone viewport measured 390px document width, with a 44×44px project
view disclosure and 44px Layout/footer targets. Independent Chromium inspection
at 1024×800 with a coarse pointer also measured a 44×44px disclosure, 76px
reserved name padding and no overlap with the reorder handle.

## Checks and fault evidence

- Initial owner/header/identity suites: 120 passed, one fallback test skipped
  because Chromium was present. The fallback is the missing-browser failure
  sentinel, not a skipped product scenario.
- After review fixes: 76 passed across sidebar composition, row, footer and
  wide-touch geometry, with one missing-browser sentinel skipped.
- Implementer fault check at `7743a0400d5`: 14 row tests passed; disabling the
  collapsed-project menu branch produced two intended missing-popup failures
  and 12 passes; restoring the owner byte-for-byte returned 14 passes. Restored
  Git blob: `f930a53b73fbcfbb7154d8d7b45b6905bf9496be`.
- Independent verifier: 75/75 with temporary complete-pointer-sequence probes,
  then 73/73 committed owner tests after byte-identical restoration. An earlier
  independent footer injection replaced Customize's surviving More return target
  with its unmounted inner trigger: the collapsed-footer test failed with focus
  on body, then passed after restoration. No verifier source edits remain.
- UI and browser-fixture typechecks, fixture-policy check and UI build passed.
  Final build measured 315759/430000 gzip JS bytes and 51314/54000 gzip CSS bytes.
- The diagnostic changed-test selector deferred its larger lanes; it is not a
  full-regression receipt. Repository gates and hosted status are reported in
  the PR separately.

Live Chrome exercised expanded/collapsed navigation, header Layout selection,
Escape/focus return, Customize return to More, second-trigger-click dismissal,
and desktop-to-phone popup retirement. These checks caught issues absent from
the initial component tests; regression assertions now cover those boundaries.

## Independent review

Fresh review of `9691a053b36` found three P2 blockers: pointer focusout reopening
a popup, a wide-touch disclosure below 44px, and a portal surviving transition
to a closed mobile drawer. Delta review through `7743a0400d5` found all three
resolved and no new blocker. The verifier separately confirmed the pointer
issue and its repair. Deletion review found no blocker.

## Panel reference assessment

The reference screenshots distinguish global navigation from a panel's surface
picker. Station already has the same foundation: `RegionEmptyChooser`, region
“+” controls, move/resize controls, and one surface inventory. A local check
opened the empty Right region and selected Files in project context:
[existing chooser](existing-panel-chooser.png).

The useful next design step is a visible, labelled picker from the header,
while keeping panel creation opt-in. The current header chooser is reached by
right-click or long press. This implementation preserves the panel model and
controls; it does not redesign them or claim the full placement/lifecycle
matrix has been verified.

## Limits

No physical-device/native-shell test, provider execution, second-account test,
full-regression run, Gallery comparator, hosted check, or merge completion is
established by this record. Canonical unsaved-navigation seams remain; a full
live dirty-editor navigation matrix was not repeated. Historical learning
captures retain their original revisions and now label their old navigation
chrome explicitly.

## Visual fidelity correction

The initial captures above remain evidence of `7743a0400d5`, which the user
found did not match the approved mockup closely enough. The corrected sidebar
and header are implemented at `0bff7654025`; Tasks content is unchanged.

The correction restores project identity tiles, decorative view icons,
aligned labels, indented views and quiet active-view styling. The app header
is the sole desktop collapse owner. The expanded footer remains one row.
Activity uses a timeline glyph, and Personal Boards is separate from project
Layouts, with its first-create action visible even when empty. The collapsed
rail has one Personal Boards navigator rather than a stack of Board icons.
Loading and failed reads remain visible; unavailable lists cannot create a
Board with a guessed slug. Switching Station authority retires the navigator.

| Corrected state | Real-app capture |
| --- | --- |
| Expanded sidebar and retained header | [Expanded](fidelity-expanded.jpg) |
| 52px rail | [Collapsed](fidelity-collapsed.jpg) |
| Configured project views | [Project popup](fidelity-project-menu.jpg) |
| Personal Boards | [Boards popup](fidelity-boards.jpg) |
| 390px phone drawer | [Mobile](fidelity-mobile.jpg) |
| Light theme | [Light](fidelity-light.jpg) |

These captures use the same isolated development home on ports 3842/5874,
with three sample projects and two personal Boards created through the UI.
Only Coding and Tasks are configured for Station. Default's connection
indicator is an observation in that isolated instance, not provider evidence.
Desktop captures are 1440×900; the mobile capture is 390×844. The temporary
viewport override was reset after capture.

Focused verification: 129 passed across nine UI suites, with one
missing-browser sentinel skipped because Chromium was available. Six targeted
browser journeys passed: vertical view containment, Up/Down focus, centered
rail tiles, aligned headers with one collapse control, collapsed footer
utilities, and surviving sidebar/chat/help transitions. The first browser
run found decorative icon text in a raw-text focus assertion and a missing
knowledge-roots fixture response; corrected owner assertions and the explicit
read response passed on the second run. The fixture-policy check and UI/E2E
typechecks passed. The changed-test selector deferred its larger lanes and is
not a full-regression result.

Independent report-only review inspected the source delta and all six
captures. Both findings were repaired: obsolete browser assertions now check
the replacement behavior, and the Boards owner remounts on Station authority
replacement, covered through the mounted sidebar. No remaining blocker was
found. Native title-bar geometry and fresh hosted Gallery qualification are
not established by this correction's local evidence. The PR remains open
with auto-merge disabled pending visual feedback.

Fault checks on clean committed `7b642e39d5b`: disabling the collapsed Boards
popup caused three intended failures (navigator lifecycle, authority-change
precondition, and first-create in the popup), with 39 passes. Restoring the
owner byte-for-byte returned 42 passes. Separately removing the Boards
owner's authority key caused the authority-replacement test to fail with the
old popup still present (41 passed); byte-for-byte restoration returned all
42 passes. No fault edits remain.

## Hosted Gallery follow-up

Run `38853843125` captured all 56 screens on `a9cb3be48c66`. Artifact
`12027086292` (`gallery-pr-38853843125-1`) has ZIP SHA-256
`7645cf8e7ca0d8a7dad280f71ea40fdd95be164198b6831422b77b77bd9bd08d`.
Exact comparison found 37 changed desktop screens, 18 unchanged screens and
one existing volatile entry. Review of baseline/current/diff images traced
the differences to the revised workspace map and taller header, including
content repositioning. No masks, thresholds or comparator changes were made.

Independent visual review found one blocker: the sole desktop map-toggle
SVG was squeezed by inherited horizontal button padding. The browser keeper
at `7c2632a86be` reproduced an 8px-wide SVG against its 16px minimum. The fix
loads scoped header styles that remove desktop toggle padding and reserve a
nonshrinking 16px SVG. Mobile omits `aria-expanded`, so the desktop-scoped
selector leaves its existing menu glyph styling intact. All four browser
sidebar geometry cases and eight HeaderChrome cases pass after the fix.
Independent source review found no blocker in the repair.

This artifact is retained as diagnostic evidence and has not been adopted as
a baseline. A fresh hosted capture must qualify the corrected glyph before
reference adoption. Earlier local screenshots above retain their recorded
source revision and predate this small glyph-size repair.

## Corrected hosted reference adoption

Run `38856746806` captured all 56 screens on `3face3e11d5`. Reviewed artifact
`12028639233` (`gallery-pr-38856746806-1`) has ZIP SHA-256
`4c4aa82eb413675fa85d058329b283cb2fa36bb710e09e704854b59f4ba4c46f`.
The baseline comparison reported 37 changed desktop screens, 18 unchanged
screens and the one existing volatile entry.

Independent decoded-pixel comparison with the prior reviewed artifact found
36 scenes changed only at the repaired header toggle (148 pixels per scene,
x=239..252, y=16..27). The two New Project scenes changed only in the
corresponding blurred backdrop area; modal content was unchanged. The other
18 scenes, including mobile, were pixel-identical. Independent image review
found the toggle legible and no unexplained visual regression.

Baseline-only commit `c59a329e594` adopts that exact hosted artifact through
`npm run screenshot:baseline`. It changes 37 reference PNGs and their manifest
hashes, preserving the existing volatile entry byte-for-byte. No capture
code, comparator, mask, threshold or exception changed. Comparing the same
artifact against the updated references passes 55/55, plus one existing
volatile skip. This establishes reference consistency, not a fresh hosted
render on the baseline commit or completion of the merge queue.

## Integration with current main

Merge commit `8dcf4516a96` integrates main `d6c25a3c0728` into the reviewed
`b09c8b123120` branch without rebasing. All 15 conflicts were screenshot
references: the manifest and 14 PNGs. Reference selection follows the parent
deltas: retain branch-only updates, retain main-only updates, and use main's
newer reviewed reference for overlapping updates. All 55 nonvolatile image
hashes and dimensions match the resolved manifest; the existing volatile
entry is unchanged. These are parent capture references, not a fresh render
of the integrated source.

Main's #3726 Gallery workflow and comparator policy are retained unchanged:
exact pixel differences are review advisories, while capture and comparison
integrity failures remain errors. The default local comparator remains
strict. No new exception, mask or threshold is introduced by this resolution.
The previously recorded strict hosted Gallery PASS remains bound to
`b09c8b123120`, not to this merge.

Independent source/resolution review confirmed that the sidebar/header and
popup lifetime fixes remain unchanged from the branch parent, and upstream
Gallery fixture-lifetime and viewport fixes remain intact. Auto-merged
settings retain upstream telemetry controls while keeping the retired
`sidebar-sections` entry removed. The canonical settings generator produced
no additional changes. Eight focused files pass 285 tests, including mounted
sidebar/Boards/footer/header, settings authority, comparator and workflow
contracts. Fresh hosted qualification of the integrated candidate remains
outstanding.

The integrated browser run initially passed three geometry cases and failed
before keyboard movement: the trace showed `#root[inert]` while the upstream
**Starting Station** dialog was active, so programmatic focus did not enter
the Layout row. The fixture now waits for that dialog to close before asking
for focus, preserving the startup gate and all keyboard assertions. The final
four-case browser geometry run passes. A six-screen local capture also passes
Home, Agents, Settings, desktop/mobile conversation resync and dock project
mismatch, including upstream recovery assertions. No local capture is used to
refresh references or presented as hosted rendering evidence. Fixture guards
pass 33 tests, and the E2E typecheck passes.

## Merge-queue guardrail repair

Merge group `b1e846f29eb6` failed process-heavy corpus run `38886820657`
because the positive control in
`proof-repo-guardrails-fail-closed.test.ts` still required the retired
`sidebar__collapse-button` source token inside `ProjectSidebarHeader.tsx`.
The local pre-fix suite reproduced exactly that finding: one positive-control
failure and 15 passes.

Commit `d33441917cd` removes only the obsolete CSS-token requirement. It
retains the sidebar-header export and container extraction checks, all other
guardrail checks, the exact-PASS/exit-zero positive control, and missing-source
negative fixtures. The executable proof now passes; fail-closed/header owner
suites pass 27/27. Browser geometry passes 4/4.

On clean `d33441917cd`, temporarily renaming the real Header's toggle event
made the browser keeper fail at the missing **Expand workspace map** state
after clicking the visible control. Byte-identical restoration returned that
case to green. No injected edits remain. The keepers exercise the actual
header collapse action rather than requiring a removed control's source text.
Application, capture and reference bytes are unchanged by this repair; earlier
hosted results retain their exact-head attribution. Fresh hosted/queue
qualification is still required for the new head.

## Account-preferences integration

Merge `2eccebaf096` integrates main `672aa69b0532` into `8ede7c75d394`
without rebasing. Three conflicts were resolved: the exhaustive settings
scope test keeps upstream account scopes for Diff style, Diff wrap and Theme,
while retaining removal of `sidebar-sections`; the screenshot manifest and
Settings PNG retain main's newer reviewed Settings reference and branch-only
references elsewhere. All 55 nonvolatile hashes/dimensions match the selected
images; the volatile entry is unchanged. The settings registry regenerates
70 settings without additional changes.

Sidebar/header source and the queue guardrail repair remain unchanged.
Independent conflict review found no blocker and confirmed that account
preferences, workspace-map instructions and historical media notes from both
parents survive. Eight focused files pass 213 tests, including account
preferences, settings scopes, sidebar/header and the fail-closed proof. The
executable guardrail proof passes. Fixture guards pass 33 tests; E2E types pass.

The initial browser run passed three geometry cases and sampled the rail's
and icon's bounds 13ms apart during collapse animation, producing a false
centering failure. The fixture now waits for the documented 52px rail width
before comparing bounds. The final four-case run passes. On clean
`c8c37aca598`, a temporary 56px width mutation fails that assertion with
expected 52px/received 56px; byte-identical restoration returns the case to
green. No injected edits remain. A local Home/Settings/mobile-Settings capture
passes and was visually inspected; it is not used for reference generation.
All hosted qualification claims above remain bound to their recorded heads;
the new integration still needs hosted and merge-queue qualification.


## Onboarding integration

This merge integrates main `9658fa21a33e` into `4efaa71d1549` without
rebasing. It retains the compact workspace-map footer, Personal Boards and
retired Open chats/Drafts settings while adopting upstream Connections naming,
phone pairing and Coding/chat chrome. Developer chooser visibility follows the
Developer setting, including its account overlay; the old device-only wording
was corrected after independent review.

The three conflict resolutions preserve both parents' intent: settings prose
combines the footer contract with Connections naming, and the screenshot
manifest retains independent parent changes while main wins the sole overlapping
New Project modal reference. All 55 nonvolatile reference hashes and dimensions
match the selected parent images; the volatile entry is unchanged. These are
historical parent references, not proof of this merged rendering. Sidebar/Header
owner source and the queue guardrail repair are unchanged.

Independent source/reference review found no blocker after the wording correction.
Ten focused files pass 206 tests with one skipped test. E2E types and 33 fixture
guards pass. All four sidebar geometry cases pass. Local captures of Home,
New Project, a project-bound dock and the 320px mobile chat header pass and were
visually inspected. They are not used to regenerate references or represented as
hosted evidence. Fresh hosted and merge-queue qualification remain required.
