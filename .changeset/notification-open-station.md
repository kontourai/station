---
"@kontourai/station-contracts": minor
---

Add `NOTIFICATION_STATION_QUERY_PARAM`, `isNotificationStationId` and `notificationSessionHref` to `@kontourai/station-contracts/notification`. Every OS notification link now names the Station that sent it, and every channel opens a session through one href, so a client connected to another saved Station switches to the sending one before it opens the conversation.
