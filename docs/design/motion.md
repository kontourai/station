# Motion grammar

Station motion communicates state and spatial relationships. It is not a
decoration layer. Components consume the semantic tokens in `tokens.css`; new
hard-coded durations/easings and `transition: all` are rejected by
`motion-contract:ratchet`.

## Categories

| Category | Contract | Typical tokens |
| --- | --- | --- |
| Feedback/state | Immediate acknowledgement without moving layout. Animate color, opacity, transform, or shadow. | `--motion-fast`, `--ease-standard` |
| Entrance/exit | Preserve where a surface came from. Animate opacity and transform; remove non-essential movement under reduced motion. | `--motion-base` or `--motion-slow`, directional easing |
| Direct manipulation | Pointer/finger movement is 1:1. Do not transition the property being dragged or resized. Snap/release feedback may animate after release. | `--motion-instant` while manipulating |
| Perpetual status | Motion may indicate live work but cannot be the only status signal. Stop after one iteration under reduced motion. | `--motion-status-spin`, `--motion-status-pulse`, or `--motion-status-breathe`; `--ease-linear` for rotation |

## Property contract

Prefer compositor-friendly `transform` and `opacity`. Color, border-color,
box-shadow, and background-color are allowed for bounded state feedback.
Do not animate layout properties per frame (`width`, `height`, positional
insets, margin, padding) during direct manipulation. Never use
`transition: all`.

The global `prefers-reduced-motion: reduce` rule makes state changes effectively
instant, disables repeated animation, and preserves the final visible status.
A component exception must explain why motion is essential and include a local
test.

That global rule zeroes `animation-duration` and `transition-duration`; it
does NOT zero `animation-delay`. Anything animating with a delay (a staggered
list entrance, for example) must also zero its own delays under reduced
motion explicitly, or a still-mounted element sits invisible for its
un-zeroed delay before its (now-instant) animation ever starts.

## Migration and ratchet

The app shell, page navigation, Schedule surfaces, transient notifications,
chat, and (station#753) every remaining legacy surface now consume the shared
grammar. A migrated file has no ceiling, so a new literal duration or easing
fails the ratchet immediately. `scripts/motion-contract-baseline.json` carries
exactly two exceptions, both coupled timing constants a token would decouple
from what they represent rather than express:

- `NotificationHistory.css`'s dismiss-collapse animation duration is `4s`
  because it visually encodes `UNDO_WINDOW_MS` (the undo window's actual
  dwell time, from `NotificationHistory.tsx`) rather than a motion-grammar
  duration.
- `VoicePill.css`'s two audio-reactive transitions (`.voice-pill--listening`,
  `.voice-pill__ring`) are `0.08s` because `--audio-scale`/`--audio-glow` are
  republished on every microphone frame (`NovaVoiceSessionAdapter.ts`
  `handleMicrophoneFrame`) — Direct manipulation, not Feedback/state: the
  duration is a signal-smoothing time constant tied to how fast the signal
  itself updates, not a motion category. `--motion-fast` was tried and
  reverted: at 150ms the transition restarts before completing on every new
  frame and never resolves.

Each carries a local test pinning its literal
(`NotificationHistory.motion-exception.test.ts`,
`VoicePill.motion-exception.test.ts`) per the exception rule above. Lower
both the global count and the affected per-file ceiling whenever a future
addition needs a temporary exception.

## Route entrance

One entrance, declared once, at the `AppViewContent` seam
(`src-ui/src/app-shell/route-transition.css`). It replaces `.page`'s private
`page-fade-in`, which two things were wrong with: it animated an 8 px slide and
never touched opacity despite its name, so every route popped in at full
opacity; and the eight split-pane routes are not `.page` descendants, so they
had no page-level entrance at all. A second, DIFFERENT `page-fade-in` keyframe
was declared globally in `editor-layout.css`, so stylesheet load order silently
decided which of the two every `.page` in the app used; that one is now
`editor-enter`.

A route's pending state is the suspended route outlet itself
(`RouteViewBoundary`'s Suspense fallback publishes it, and only while it is
mounted), which the sidebar renders on the row the user clicked. Measured on
the audited build: a cold route chunk takes ~1.4 s to arrive, during which the
outlet already shows a skeleton but the nav said nothing.

The screenshot bucket exercises reduced motion on desktop navigation,
Schedule loading and modal states, a notification, and the mobile chat dock at
390x844. Those captures also assert the computed motion contract before writing
the visual evidence.
