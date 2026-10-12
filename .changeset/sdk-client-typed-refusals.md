---
"@kontourai/station-sdk": minor
---

The remaining `@kontourai/station-sdk/client` fetchers throw typed refusals
(#2708). The account, application-session, authority-observation,
checkpoint-restore, conversation pull-request link, fleet-routing receipt,
learning-source, personal Board and Project layout delete, pull-request
review, quote-source, runs and setup-import fetchers throw a
`StationHttpError` with the observed `status`, `code`, `details` and
`retryAfterMs`; several threw a plain `Error` before. `BoardResponseError`,
`DelegationApiError`, `AnswerSupportRequestError`,
`ActionOperationProtocolError`, `LiveActivityProtocolError`,
`AnswerBasisRequestError`, `AnswerNarrativeBindingRequestError` and
`FlowGateEvaluationRequestError` keep their constructors and gain those
fields. A validation refusal's message now names each field
(`Validation failed: name Required`); read `details` for the bare reasons. A
refusal whose body is not JSON keeps its status instead of surfacing a parse
error.
