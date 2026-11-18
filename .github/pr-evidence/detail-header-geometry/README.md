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
