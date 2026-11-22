---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

An Automation rule's action and a source's grant may name their Project by
slug as well as by id. Station stores the Project's id; when a value is one
Project's id and another's slug, the id wins. Creating or editing a rule or
grant that names no Project is refused, quoting the value. A delivery whose
rule names a Project that no longer exists is refused with the new reason
`project_unavailable` in `AUTOMATION_REFUSAL_REASONS`, and no Task starts.

`AutomationEpisodeRecord` gains an optional `startFailed: true` for an open
episode whose latest start failed before its Agent started; retry-episode
now accepts such an episode, with `startFailure: 'agent-option-unsupported'`
when the rule asks for an approval mode its Agent cannot take.
`AutomationEpisodeList` (`GET /automations/episodes`) adds
`actionsUnavailable` while no automation Task can start, and
`listAutomationEpisodes` returns it.
