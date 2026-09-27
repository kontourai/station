# Design: bounded guided triage

> **Reading status: current diagnostic-command contract.** The
> [CLI registration](../../packages/cli/src/cli.ts),
> [triage command](../../packages/cli/src/commands/triage.ts), and
> [shared redactor](../../packages/shared/src/redaction.ts) own this path.
> The configured launch flags and local artifact tests do not establish how
> every installed agent version enforces its sandbox, or guarantee that
> arbitrary sensitive prose can be detected.

`station triage` is a diagnostic hand-off, not a repair command. It creates a
fresh UUID directory below the one app-owned root,
`$STATION_ROOT/cache/triage/<uuid>`, with directory mode `0700` and files mode
`0600`. The run contains versioned Station-owned inputs plus optional,
re-redacted diagnosis and issue-draft output. The fixed read-only GitHub search
requires separate consent; there is no GitHub mutation operation. Launching an
agent also gives that agent and its configured model service access to the run
files. `--context-only` collects the artifacts without launching an agent.

The context is allowlisted and validated before it is persisted. Its provenance
comes from the existing distribution seam; packaged builds retain their stamped
version/channel/source SHA while a checkout is always identified as development
source. Target facts come from the existing saved-Station resolver and opaque
credential-status seam. Values pass through the shared deep redactor and fixed
count, text, and serialized-byte limits. Recognized absolute paths, URLs, and
secret patterns are replaced before persistence. Redaction is pattern-based;
review the artifacts before sharing them.

The checkout launcher injects the source doctor collector through
`CliDependencies`. The command module never imports lifecycle or server code,
so the published bundle truthfully records local filesystem/doctor as
unavailable. When an authenticated credential is available, triage uses the
existing raw `/api/diagnostics/bundle` route through `authenticatedFetch` and
keeps only app version/platform/allowlisted build fields, a summarized doctor,
and a re-sanitized bounded log tail. Configuration and all other bundle content
are discarded. Missing auth and transport errors become sanitized unavailable
facts; triage never sends an unauthenticated diagnostic request.

The normal command form can launch an installed agent. Its requested modes are:
Codex receives `--ask-for-approval never exec --sandbox read-only --ephemeral
--ignore-user-config --skip-git-repo-check`; Claude receives `--safe-mode
--no-session-persistence --no-chrome --disable-slash-commands --tools
Read,Glob,Grep --permission-mode plan --print`. Both executions use argument
arrays, `shell: false`, and `windowsHide: true`; a short argument points agents
at the run-local playbook instead of embedding a multiline prompt. A missing
agent does not make collected artifacts unusable. When both agents are
available in a TTY, Station asks the owner to choose; a non-TTY fails with a
remedy after artifacts exist. The playbook is bundled with
the command—not fetched from mutable source prose—and prohibits state writes,
repairs, service operations, source changes, and every GitHub write. Station
retains the first 64 KiB of stdout, re-redacts it, and writes `diagnosis.md`
plus `issue-draft.md` with model/agent and harness attribution, including after
an unsuccessful agent exit. Live stdout is forwarded before redaction; stderr
is inherited directly. The stored-artifact policy does not sanitize that terminal
output. Launch flags and instructions request read-only behavior; they do not
independently prove enforcement by the installed agent.
