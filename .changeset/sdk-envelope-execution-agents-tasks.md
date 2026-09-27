---
'@kontourai/station-sdk': minor
---

The Agent, execution, Task output and Task room fetchers now keep what Station
answered when it refuses a request: the observed status, the envelope's
`code`, `details` and `Retry-After`, with a message that names each field of
a validation refusal (`Validation failed: name Required`). A failure whose
body is not JSON (a proxy's HTML 502) keeps its status instead of throwing a
bare `SyntaxError`; an unreadable 2xx is still a plain `Error`.

- The Agent fetchers (`getAgent`, `fetchAgentCatalog`, `createAgentDetailed`,
  `createAgentRaw`, `materializeEngineAgent`, `updateAgentRaw`,
  `deleteAgentRaw`) throw `StationHttpError`. A `200` carrying
  `{ success: false }` now has status `200`.
- `ChatHttpError` now extends `StationHttpError`, so it carries `details` and
  `retryAfterMs` too, and a `catch` that tests `instanceof StationHttpError`
  first now also matches it. It gains a constructor that takes the
  `StationHttpError` the client built; `(status, serverMessage, code)` still
  works. `ForegroundMessageIndeterminateError` likewise gains a
  `(failure, detail)` form beside `(status, message, detail)`.
- `ProjectTaskRoomProtocolError` gains optional `status`, `code`, `details`
  and `retryAfterMs`, set only when Station refused the request.
- The protected reads stay opaque. `TaskToolResultRequestError`,
  `TaskUserInputReferenceRequestError`, `TaskBasisRequestError`,
  `SessionOutputsRequestError` and `SessionInventoryRequestError` keep their
  generic message and add the refusal's `code` and `retryAfterMs`; their
  constructors also accept the `StationHttpError` the client built.
  `getInputReplyContext`'s error keeps its generic message and adds `code`
  and `retryAfterMs`. None of them carries the route's words or `details`.
