---
'@kontourai/station-shared': patch
'@kontourai/station-cli': patch
---

`station start --temp-home` and `station fresh --temp-home` no longer fail
when run by an agent Station spawned. That agent's `TMPDIR` is
`<home>/tmp/engine-spawn`, so the temporary home either was refused as a
non-leaf instance path or, under a self-rooted parent home, was admitted into
a tree the parent reaps by age. A candidate under the `tmp/` tree of
`STATION_HOME` or the resolved Station root, or one the runtime-home guard
refuses, is now removed and the home is created under `/tmp/station` instead
(not on Windows). When that retry is refused too, the error reports both
refusals. `createStationTempDirSync` accepts an optional `root`.
