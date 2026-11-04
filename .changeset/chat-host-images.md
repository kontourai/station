---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

Add the `chat-host-images` contract subpath and the `content.host-images` canonical runtime event: a settled turn's map from each host image path its reply named to the attachment Station stored, or to the reason it did not keep it. `projectRuntimeEventsToMessages` now carries that map on the turn's assistant rows as `metadata.hostImages`. Engines cannot emit the event (`ProviderRuntimeEvent` excludes it).
