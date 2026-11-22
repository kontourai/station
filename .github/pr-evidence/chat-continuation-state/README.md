# Chat continuation evidence

Retention: source-pinned continuation evidence for #2168, #4240 and #2487.
Retain with the PR.

The Chromium composer fixture gives the client a local exit and an open
result without an authorized next-Session claim. Before uses the original
engine helper from `3ac758dfc05`. After uses `ab01c08edd6`.

| Viewport and theme | Before | After |
| --- | --- | --- |
| 1440px light | [Before](before-1440-light.png) | [After](after-1440-light.png) |
| 1440px dark | [Before](before-1440-dark.png) | [After](after-1440-dark.png) |
| 390px light | [Before](before-390-light.png) | [After](after-390-light.png) |
| 390px dark | [Before](before-390-dark.png) | [After](after-390-dark.png) |

Before, the composer promised the next turn would start on the Agent's
new engine. The revised composer says that the Agent moved. A separate
Chromium control confirms a current affirmative open still displays the
destination. The browser also reloads and submits a draft through the
actual composer with a controlled fresh-context open response.

The local server fixture reads authorized earlier history and dispatches a
real continuation command through a controlled adapter. Its accepted Session
matches the reservation and receives only the new prompt. No live provider,
remote host, or native engine startup was exercised.
