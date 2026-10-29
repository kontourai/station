# Sheet gesture and context row captures — PR #4242

Retention: source-pinned visual evidence for this PR; retain with its review history.
These inspected screenshots show UI state in desktop Chromium (Playwright), not
physical-device touch behavior.

Each capture renders the real `ChatDockMobileOverflowSheet` (the phone chat
header's **⋯** Actions sheet) with the production `index.css` and `chat.css`.
The stats read is stubbed at 19.1%, and the connection row is stubbed out.

- `mobile-actions-before-{light,dark}.jpg`: `main` at
  `8ba48bfa3ea62dc5ca2d3ad2f88e8f9a9bd64428`, 390×844.
- `mobile-actions-after-preview-off-{light,dark}.jpg`: this branch with the
  Sheet gestures preview off. The only change is the **Conversation stats** row
  naming "Context 19% used".
- `mobile-sheet-handle-rest-{light,dark}.jpg`: preview on, at rest. The grip is
  centred on the sheet's top edge.
- `mobile-sheet-dragging-dark.jpg`: preview on, mid-drag upward (150px), with
  the panel's height following the pointer.
- `mobile-sheet-full-{light,dark}.jpg`: preview on, after releasing a 450px
  upward drag. The sheet rests at Full, 16px below the top.
- `desktop-actions-{light,dark}.jpg`: preview on at 1440×900. No handle, because
  the gesture is phone-width only.

Pointer input was driven with Playwright's mouse, so these captures do not
show Android or iOS touch handling.
