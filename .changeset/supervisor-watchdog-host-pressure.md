---
"@kontourai/station-cli": patch
---

Stop the Station service from restarting a working server or UI process just because the host is busy. When a process keeps missing health checks while it's alive and its port is listening, the supervisor normally runs a confirmation probe after 180 seconds and restarts the process if that fails. If the host is CPU-starved at that point, the supervisor now waits instead, logging the pressure reading it saw. It waits for at most 15 minutes of continuous failure, then confirms and restarts a process that still doesn't answer.

How pressure is measured depends on the platform:

- **Linux:** CPU pressure stall information (PSI) of 25% or more over the last minute. In a container with its own cgroup namespace (Docker's default under cgroup v2), its `cpu.pressure` is used instead of the host-wide file.
- **macOS, or Linux without PSI:** a one-minute load average of 1.5 or more per CPU.
- **Windows:** neither signal exists, so the 180-second timing is unchanged.

A process that has answered with another Station's identity during the failure window is never given extra time.
