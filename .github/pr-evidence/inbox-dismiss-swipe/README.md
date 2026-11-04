# Inbox dismissal and mobile swipe captures

Before: `3114febff625f891f689b8b3f6659740a06efb71`.
After production code: `d05bd2edf`; after test fixture: `67662f997`.

The before captures mount the baseline's production ChatDockInboxPanel and
MobileTaskSwitcher with the same two sample saved conversations as
`src-ui/src/__tests__/inbox-swipe.browser.test.tsx`. After captures come from
that browser test. Each surface was inspected at 390 and 1440 pixels in dark
and light themes. The mobile after images show the first row swiped left;
the desktop images show the first row hovered. Before, that saved conversation
has a clock but no X; after, it also has Dismiss.

These are component captures in Chromium. On-demand remote Details reads are
disabled through a null authority scope; the production row, gesture, grouping,
Snooze, dismissal and Undo owners run. Browser checks exercise actual touch
input, action hit targets, Snooze choices, Dismiss/Undo and preview-off Details
recovery. They do not establish physical-device, native-shell, live-provider
or multi-device synchronization behavior.

Retention: permanent — source-pinned before/after evidence for this change.
