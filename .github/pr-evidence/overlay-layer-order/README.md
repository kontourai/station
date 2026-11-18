# Modal stacking and notification hit testing

Retention: source-pinned evidence for #1684 and #1696. Retain with the PR.

Chromium captured the actual CommandLauncher, ActiveWorkContextFrame and
ComposerActionsMenu markup over the actual pending-approval notification
markup and production CSS. The matrix includes 390px phone cases and the
1440px command launcher, in light and dark. The old sources are from
`e0693127d2d` and the repair is from `5a2b93089ce`.

Before, pressing the centre of the pending-approval pill hit the
notification even though a modal scrim occupied that point. After, the scrim
dimmed the pill and received the press. The command launcher and mobile
task context leave the dock's stacking context. The anchored phone Composer
Actions sheet takes the dialog layer, and its desktop popover keeps the
declared layer.

The live-component browser test measures the hit and then uses real mouse
and keyboard events to verify dismissal, focus containment and focus return.
It uses the app components and cascade with a fixture notification. Both
broader routed tests stopped before opening the dialogs because the fixtures
expected older project-context and Files controls.
