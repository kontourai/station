---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-cli': minor
---

Terminal history retention settings (#3994): `terminalHistoryEnabled`,
`terminalHistoryDirectory`, `terminalHistoryMaxAgeDays`,
`terminalHistoryMaxTerminalMiB` and `terminalHistoryMaxTotalMiB` in `AppConfig`
and the settings registry, refused outside their ranges. The SDK adds
`fetchTerminalHistory`, `clearTerminalHistory`, their query hooks and
`openOrAdoptProjectShell`; `TerminalSessionRecord` gains `ordinal` and
`restoredAt`. `station doctor` reports each running instance's terminal shell
host and the PTY host bundle.
