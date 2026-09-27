---
'@kontourai/station-shared': minor
---

Resolve Windows PowerShell by its System32 path for process-birth probes, give the
lock's own-process lookup the Windows cold-start budget, and name the failed probe
in lock errors. Removes `resolveProcessBirthFingerprint` (`./lifecycle-events`) and
`WINDOWS_OWN_PROCESS_BIRTH_ATTEMPTS` (`./process-identity`), which nothing used;
`ownProcessBirthProbeSchedule` now owns the retry schedule.
