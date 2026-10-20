---
'@kontourai/station-contracts': patch
---

Correct the Default approval mode setting's description: Full access turns off approval prompts where the engine allows it, but a start without a full-access grant, such as a webhook, still runs inside Station's workspace confinement. It no longer says such sessions run with no sandbox.
