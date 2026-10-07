---
'@kontourai/station-contracts': minor
'@kontourai/station-shared': minor
'@kontourai/station-sdk': minor
---

Clients now state their client API protocol in `X-Station-Client-Protocol`
(`CLIENT_PROTOCOL_HEADER`, parsed by `readClientProtocolHeader`). A host
refuses a protocol below its advertised `minClientProtocol` with HTTP 426
`client_protocol_unsupported` and a malformed header with 400
`client_protocol_invalid`; an absent header reads as protocol 1. The SDK
request seam sends the header where no CORS preflight can refuse it
(`@kontourai/station-shared/client-protocol`).
