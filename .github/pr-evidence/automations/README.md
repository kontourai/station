# Automation operator surface and Task mandate

Retention: kept as the rendered evidence for #4511 and #4513. Superseding captures may replace this directory after review.

Captured in Chromium from the production UI and HTTP routes on the merged tree at `9097ffae3b8470af6a21a00f65afa2fa3086d936`, with the subsequent server-only hand-over correction in progress. The isolated Station used a temporary home, instance `t3a64-automations`, server port 3442 and UI port 3474. No real engine ran. An authenticated operator created the source, rule, Project and Task through HTTP; the ledger/mandate data was seeded with Station's own ledger and intake APIs. These are fixture-rendering artifacts, not live GitHub/provider or installed-app qualification.

All eight PNGs were opened for inspection. They are byte-identical to the earlier implementation captures, which were also opened. The [receipt](receipt.json) records list headings and row counts (1/1/2/3) and no page-width overflow at each width/theme. Tall region screenshots include the fixed mobile dock at the viewport edge; they do not establish every scroll position. No pre-feature baseline was captured, so no before/after layout comparison is claimed.

| Surface | 390 light | 390 dark | 1440 light | 1440 dark |
| --- | --- | --- | --- | --- |
| Settings | [PNG](settings-light-390.png) | [PNG](settings-dark-390.png) | [PNG](settings-light-1440.png) | [PNG](settings-dark-1440.png) |
| Task Details | [PNG](task-light-390.png) | [PNG](task-dark-390.png) | [PNG](task-light-1440.png) | [PNG](task-dark-1440.png) |
