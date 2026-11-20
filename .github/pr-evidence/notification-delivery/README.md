# Web Push Settings evidence

Retention: source-pinned Settings evidence for #2759. Retain with the PR.

Chromium mounts the production Web Push hook, SDK discovery client, and
Settings status with the production styles. The fixture supplies a browser
subscription and a controlled VAPID 401 response. Before uses the original
hook and SDK at `aeabebdadd9`. After uses `b8a4e0c55c7`.

| Viewport and theme | Before | After |
| --- | --- | --- |
| 1440px light | [Before](before-1440-light.png) | [After](after-1440-light.png) |
| 1440px dark | [Before](before-1440-dark.png) | [After](after-1440-dark.png) |
| 390px light | [Before](before-390-light.png) | [After](after-390-light.png) |
| 390px dark | [Before](before-390-dark.png) | [After](after-390-dark.png) |

The original state reports a generic retry. The revised state asks the
person to sign in to the selected Station. The same fixture rechecks on
reconnect and distinguishes HTTP 403 and 404 from authentication failure.

The browser has a controlled local subscription and Station response.
Live push delivery, physical devices, native notification display, and
gateway deployment require separate verification.
