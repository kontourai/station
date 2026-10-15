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
