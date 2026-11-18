# DetailHeader browser measurements

Retention: source-pinned review evidence for #1678, #1689 and #1699. Retain with the PR.

The probe rendered the production DetailHeader component in Chromium with
the app cascade and the Monitoring, Engine and split-pane rules. It used
synthetic titles, subtitles and actions representing current consumers and
stress cases. These captures establish browser geometry for those shapes.

| Available region | Viewport | Before, actions sharing the row | After, actions sharing the row |
| --- | --- | --- | --- |
| 900px | 1000px | 0 of 14 | 14 of 14 |
| 900px | 1440px | 14 of 14 | 14 of 14 |
| 700px | 1000px | 0 of 14 | 13 of 14 |
| 700px | 1440px | 13 of 14 | 13 of 14 |
| 500px | 1440px | 10 of 14 | 10 of 14 |
| 390px | 390px | 0 of 4 | 0 of 4 |

Before used `c5837006326`. After used the stylesheet committed at
`4f9732df968`. In the 900px tablet region, the integration fixture fell from
146px to 78px high with 44px action targets. The 700px region in a wide
window showed a synthetic plugin token painting 1389px outside its subtitle
box before the repair and zero after. Phone stacking and the desktop
row-placement decisions stayed the same for the measured cases.

## Mounted product views

The isolated product runner opened the real routes at 900px, 1000px and
1100px. It used the existing Connections, Project forms, Agent editor and
Skills fixtures and exercised the server-backed installed plugin rejection
and repair flow. The configured ACP retry case supplied the same failed
engine state to the fixture's list and detail reads and a matching ACP
connection. Chromium measured the visible app header after its fonts loaded.
Each cell gives the actual header width and where its actions were placed.

| Consumer | 900px viewport | 1000px viewport | 1100px viewport |
| --- | --- | --- | --- |
| Agent editor | 387px, second row | 487px, second row | 587px, second row |
| Ready engine | 387px, no actions | 487px, no actions | 587px, no actions |
| Failing configured ACP engine | 387px, same row | 487px, same row | 587px, same row |
| Unconfigured engine | 387px, no actions | 487px, no actions | 587px, no actions |
| Custom engine setup | 636px, no actions | 736px, no actions | 836px, no actions |
| Integration editor | 387px, second row | 487px, second row | 587px, second row |
| Installed plugin detail | 387px, second row | 487px, second row | 587px, same row |
| Rejected plugin detail | 387px, second row | 487px, same row | 587px, same row |
| Project settings | 684px, same row | 784px, same row | 884px, same row |
| Provider type picker | 460px, same row | 460px, same row | 460px, same row |
| Provider settings | 387px, same row | 487px, same row | 587px, same row |
| Skill detail | 323px, second row | 423px, second row | 523px, same row |

All 36 measurements kept the identity and action group inside the header.
No subtitle overflowed in this sweep. Every measured direct button or link
was at least 44px high. Skills use a nested action row, so its row placement
was measured and the direct-target count is empty.

Monitoring moved to its own toolbar in [#3500](https://github.com/kontourai/station/pull/3500).
TaskWorkspaceView moved to the page-frame header in [#3991](https://github.com/kontourai/station/pull/3991)
and now uses TaskHeader for its in-workspace fallback. Those views no longer
consume DetailHeader. The current EngineAddFlow catalog and PluginRecoveryPanel
use self-closing DetailHeader elements, with any controls rendered separately
in the body or footer. The unconfigured engine header was also observed with
zero actions in the live route.

The rejected plugin's original fixture locator assumed the rejection text was
part of the row's accessible name. The successful replay selected the real
row by its current accessible name and measured the rejected and repaired
details. The temporary measurement probes were removed after the runs.

[Raw browser measurements](mounted-tablet-measurements.json)
