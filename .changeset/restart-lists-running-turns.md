---
"@kontourai/station-cli": patch
---

`station restart` now lists the agent turns it is about to interrupt before handing the instance to a new core generation, when this device holds a saved credential for that instance. It asks nothing and never delays the restart.
