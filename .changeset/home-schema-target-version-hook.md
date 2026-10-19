---
"@kontourai/station-shared": minor
---

`ensureStationHomeSchemaSync` accepts a test-only `targetVersion` hook beside the existing `migrations` hook, so tests can drive a real home migration through the gate. Production behavior is unchanged.
