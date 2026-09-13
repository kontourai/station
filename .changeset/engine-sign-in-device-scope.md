---
"@kontourai/station-contracts": minor
---

Add the `engine:login` pairing scope, which lets a device start an engine's own device-code sign-in on the Station host. It is granted only by operator promotion, never by a preset or the default grant, so older peers can still parse every scope string they are issued.
