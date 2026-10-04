---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Station's own answers are identified by a response header instead of by body
shape alone. `@kontourai/station-contracts/http` exports
`STATION_ENVELOPE_HEADER` (`x-station-envelope`) and
`STATION_ENVELOPE_HEADER_VALUE`; a current Station sends the header on every
JSON response it writes itself and never on one relayed from another Station.
`ChatHttpError.stationEnvelope` now requires the header from an origin that
has sent it before, so gateway JSON in Station's shape is no longer read as
Station's refusal. A Station that does not send the header is still read by
shape.
