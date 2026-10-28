---
"@kontourai/station-cli": patch
---

Stop the Station service restarting a working server just because the host is busy. When the server keeps missing health checks while its process is alive and its port is listening, the supervisor normally confirms and restarts it after 180 seconds. If the host is CPU-starved at that point, the supervisor now waits instead, logging the pressure reading it saw, up to 15 minutes of continuous failure. After that it confirms and restarts a server that still doesn't answer. On Linux, pressure means CPU pressure stall information (PSI) of 25% or more over the last minute, or a one-minute load average of 1.5 or more per CPU. macOS uses the load average only. Windows has neither signal and keeps the 180-second timing.
