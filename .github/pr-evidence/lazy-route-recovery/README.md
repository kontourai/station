# Lazy surface failure and recovery evidence

Retention: source-pinned evidence for #1302 and #1712. Retain with the PR.

The Chromium fixture uses the production lazy boundary and visual styles,
with controlled loaders for Inbox and Chat actions. Before uses the boundary
from `3ac758dfc05`. After uses `0017a2f2b87`.

| Viewport and theme | Before | After |
| --- | --- | --- |
| 1440px light | [Before](before-1440-light.png) | [After](after-1440-light.png) |
| 1440px dark | [Before](before-1440-dark.png) | [After](after-1440-dark.png) |
| 390px light | [Before](before-390-light.png) | [After](after-390-light.png) |
| 390px dark | [Before](before-390-dark.png) | [After](after-390-dark.png) |

Both original rows read “Unable to load this part of Station.” The revised rows
name Inbox and Chat actions. After making only the actions loader available,
clicking Retry on the Chat actions row opens that surface. The Inbox failure
stays visible.

The remount control also uses Chromium. Giving React the frozen loader promise
directly produced two page errors about installing its status field. Both
mounts with the original tracing promise completed without browser errors.

These fixtures isolate the application boundary from network delivery and
host reachability. Authenticated first-run, native and hosted Gallery journeys
remain separate verification surfaces.
