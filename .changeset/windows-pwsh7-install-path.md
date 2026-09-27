---
'@kontourai/station-shared': patch
---

Resolve PowerShell 7 at its standard install path (`%ProgramFiles%\PowerShell\7\pwsh.exe`)
before PATH for the own-process birth probe's retry, so a cold Windows PowerShell start
on a minimal PATH no longer leaves the retry with nothing to launch.
