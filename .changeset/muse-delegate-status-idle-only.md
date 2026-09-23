---
'@kontourai/station-cli': patch
---

`station delegate status` renders an idle-only turn supervision (no declared
total budget — Muse's default) as "Turn budget: none declared for this turn"
plus its idle limit, instead of printing nothing.
