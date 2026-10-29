# Settings About page and card spacing captures — PR #4241

Retention: source-pinned visual evidence for this PR; retain with its review history.
Captured from `b3317033e0a2d6cda8e156b650da70c0882e5e06` in headless Chromium. These show UI state only, not
native shell rendering.

- `about-collapsed-dark-390.jpg`, `about-collapsed-light-390.jpg`: About in a
  preview harness at 390 px, list collapsed, both themes.
- `about-dark-390.jpg`, `about-light-1440.jpg`: the license list open, built
  from a real `npm run build:ui` license file.
- `real-advanced-390.jpg`, `real-advanced-1440.jpg`, `real-chat-390.jpg`,
  `real-alerts-1440.jpg`: Settings on an isolated instance
  (`./station start --watch --temp-home`) after the card spacing change.
  The outline around the group is focus from scripted navigation, not product chrome.
