# Design: bounded guided triage

`station triage` is a diagnostic hand-off, not a repair command. It creates a
fresh UUID directory below the one app-owned root,
`$STATION_ROOT/cache/triage/<uuid>`, with directory mode `0700` and files mode
`0600`. The run contains versioned Station-owned inputs plus optional,
re-redacted diagnosis and issue-draft output. Problem text stays local unless
the user explicitly authorizes the fixed read-only GitHub search; there is no
GitHub mutation operation.

The context is allowlisted and validated before it is persisted. Its provenance
comes from the existing distribution seam; packaged builds retain their stamped
version/channel/source SHA while a checkout is always identified as development
source. Target facts come from the existing saved-Station resolver and opaque
credential-status seam. Values pass through the shared deep redactor and fixed
count, text, and serialized-byte limits. Absolute paths, URLs, and secret-like
content are therefore not durable triage data.

The checkout launcher injects the source doctor collector through
`CliDependencies`. The command module never imports lifecycle or server code,
so the published bundle truthfully records local filesystem/doctor as
unavailable. When an authenticated credential is available, triage uses the
existing raw `/api/diagnostics/bundle` route through `authenticatedFetch` and
keeps only app version/platform/allowlisted build fields, a summarized doctor,
and a re-sanitized bounded log tail. Configuration and all other bundle content
are discarded. Missing auth and transport errors become sanitized unavailable
facts; triage never sends an unauthenticated diagnostic request.

Agent execution is opt-in to the normal command form and is capability-bound:
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
captures bounded final stdout itself, re-redacts it, and writes `diagnosis.md`
plus `issue-draft.md` with model/agent and harness attribution; the agents
receive no write authority.
