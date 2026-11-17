---
"@kontourai/station-contracts": minor
---

Add `SESSION_CONFIGURATION_REPLACED_CODE` (`session_configuration_replaced`) to
`@kontourai/station-contracts/orchestration` and map it to the `busy` provider
failure kind. A turn carries it when the session's agent configuration changed
while its engine was still running work started under the old configuration;
sending again once that work ends restarts the session under the current
configuration.
