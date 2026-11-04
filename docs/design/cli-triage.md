# Design: bounded guided triage

> **Reading status: current diagnostic-command contract.** The
> [CLI registration](../../packages/cli/src/cli.ts),
> [triage command](../../packages/cli/src/commands/triage.ts),
> [shared triage context rules](../../packages/shared/src/triage-context.ts), and
> [shared redactor](../../packages/shared/src/redaction.ts) own this path.
> The in-app flow that uses the same context rules is
> [troubleshoot with an agent](troubleshoot-in-app.md).
> The configured launch flags and local artifact tests do not establish how
> every installed agent version enforces its sandbox, or guarantee that
> arbitrary sensitive prose can be detected.

`station triage` has three modes. In a terminal it starts an interactive
troubleshooting conversation with an installed agent, which uses its normal
approval prompts. `--headless`, or stdin or stdout that is not a terminal,
selects the read-only one-shot diagnostic hand-off. `--context-only` only
collects artifacts. Every mode creates a
fresh UUID directory below the one app-owned root,
`$STATION_ROOT/cache/triage/<uuid>`, with directory mode `0700` and files mode
`0600`. The run contains versioned Station-owned inputs plus optional,
re-redacted diagnosis and issue-draft output from a headless run. The fixed
read-only GitHub search requires separate consent. Triage itself has no GitHub
write operation; an interactive agent may file only after the playbook's checks
and the person's explicit yes. Launching an
agent also gives that agent and its configured model service access to the run
files. `--context-only` collects the artifacts without launching an agent.

The run directory, artifact writes, summaries, bounds and the context
validator live in `@kontourai/station-shared/triage-context`, which the
server's in-app troubleshoot route also uses. The schema-v2 context is
allowlisted and validated before it is persisted. Its provenance
comes from the existing distribution seam; packaged builds retain their stamped
version/channel/source SHA while a checkout is always identified as development
source. Target facts come from the existing saved-Station resolver and opaque
credential-status seam. Values pass through the shared deep redactor and fixed
count, text, and serialized-byte limits. Recognized absolute paths, URLs, and
secret patterns are replaced before persistence. The one local path the
context keeps is `localLogs.directory`: the default runtime home's log
directory, passed through the issue-report redactor so the home directory is
shown as `~`. The validator refuses any other form, and a directory outside
the home directory is recorded as `null`. Redaction is pattern-based; review
the artifacts before sharing them.

The checkout launcher injects the source doctor collector through
`CliDependencies`. The command module never imports lifecycle or server code,
so the published bundle truthfully records local filesystem/doctor as
unavailable. When an authenticated credential is available, triage uses the
existing raw `/api/diagnostics/bundle` route through `authenticatedFetch` and
keeps only app version/platform/allowlisted build fields, a summarized doctor,
and a re-sanitized bounded log tail. Configuration and all other bundle content
are discarded. Missing auth and transport errors become sanitized unavailable
facts; triage never sends an unauthenticated diagnostic request.

In headless mode the command can launch an installed agent. Its requested modes are:
Codex receives `--ask-for-approval never exec --sandbox read-only --ephemeral
--ignore-user-config --skip-git-repo-check`; Claude receives `--safe-mode
--no-session-persistence --no-chrome --disable-slash-commands --tools
Read,Glob,Grep --permission-mode plan --print`. Both executions use argument
arrays, `shell: false`, and `windowsHide: true`; a short argument points agents
at the run-local playbook instead of embedding a multiline prompt. A missing
agent does not make collected artifacts unusable. When both agents are
available in a TTY, Station asks the owner to choose; a non-TTY fails with a
remedy after artifacts exist. The headless playbook is bundled with
the command—not fetched from mutable source prose—and prohibits state writes,
repairs, service operations, source changes, and every GitHub write. Station
retains the first 64 KiB of stdout, re-redacts it, and writes `diagnosis.md`
plus `issue-draft.md` with model/agent and harness attribution, including after
an unsuccessful agent exit. Live stdout is forwarded before redaction; stderr
is inherited directly. The stored-artifact policy does not sanitize that terminal
output. Launch flags and instructions request read-only behavior; they do not
independently prove enforcement by the installed agent.

An interactive launch passes the agent exactly one argument, a single-line
instruction to read the run's `playbook.md` and `context.json`, and no mode,
print or bypass flag. The child inherits stdin, stdout and stderr, with
`shell: false` and `windowsHide: true`; Station ignores `SIGINT` while it waits,
so Ctrl-C reaches the agent rather than ending Station first. The run's
`playbook.md` is byte-for-byte the bundled troubleshooting playbook v2 that the
in-app Station Assistant follows. Its terminal section takes precedence over
the in-app steps: Station and its tools may be down, so the agent works from
the run files, `localLogs` and Station's read commands; it never kills or
restarts a process without an explicit yes; and to file, it pipes the report
fields to `station triage draft-report`. That subcommand reuses the shared
report drafter, the same redactor and contracts link builder as the in-app
`draft_troubleshoot_report` tool, and prints the redacted fields, the
prefilled `troubleshoot-report.yml` URL and any overflow. The agent shows the
complete redacted text, asks for an explicit yes, and posts with
`gh issue create --repo kontourai/station --label reported:troubleshoot` only
when `gh` is authenticated and `gh api repos/kontourai/station --jq
.permissions.triage` is `true`; otherwise it gives the form URL. These rules
are instructions to the agent. Station enforces only the run's artifact
bounds; the agent's approval prompts are the operational gate.
