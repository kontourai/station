# Shortcut Settings evidence

Retention: source-pinned evidence for #2767 and #2771. Retain with the PR.

The Chromium fixture mounts the production Settings editor, registry and
device store. It captures Control+Space, reloads the page and opens Advanced.
The fixture's Preview note command registers the composer-focus condition.
The harness controls above the editor focus a test composer and open a
production dialog.

| Viewport and theme | Before | After |
| --- | --- | --- |
| 1440px light | [Before](before-1440-light.png) | [After](after-1440-light.png) |
| 1440px dark | [Before](before-1440-dark.png) | [After](after-1440-dark.png) |
| 390px light | [Before](before-390-light.png) | [After](after-390-light.png) |
| 390px dark | [Before](before-390-dark.png) | [After](after-390-dark.png) |

The before captures use the original editor, key handling and styles from
`f849d658397`. With those files restored, the registered-condition assertion fails because
the row shows Anywhere in Station and Advanced shows always.
The after captures use `e83157470f0`, show Composer focused, and retain a
read-only capture control on mobile.

The browser journey separately verifies a real Control+Space key event invokes
the handler exactly once after reload while the composer is focused. Opening a
modal suppresses the chord even with the composer condition active. The
fixture does not exercise OS-level keyboard interception or a native shell.
