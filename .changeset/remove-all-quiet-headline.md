---
"@kontourai/station-shared": minor
---

Remove `outcomeFirstAllQuietHeadline` from `@kontourai/station-shared/notification-priority`. No Station surface read it; callers that composed an all-quiet headline should inline the two strings.
