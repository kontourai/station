# Operations Context

Operations covers Station's local-first supporting systems: knowledge, scheduling, notifications, voice, terminals, telemetry, verification, and generated artifacts.

## Language

**Knowledge namespace**:
A project-scoped knowledge collection with behavior such as retrieval-augmented search or prompt injection.
_Avoid_: folder if behavior and indexing matter

**RAG namespace**:
A namespace searched semantically and returned as relevant context.
_Avoid_: injected rules

**Injected namespace**:
A namespace inserted as steering or rules rather than searched by similarity.
_Avoid_: RAG

**Knowledge document**:
A stored knowledge item with source, namespace, path, chunk count, metadata, and enhancement status.
_Avoid_: file when ingestion metadata matters

**Scheduled job**:
A configured recurring or manual job that invokes agent work and records job logs.
_Avoid_: cron string when Station behavior matters

**Scheduled run**:
A run produced by a scheduled job.
_Avoid_: interactive session

**Job log**:
The durable record of a scheduled job execution, including success, attempts, missed count, output, and error.
_Avoid_: console output

**Notification**:
A surfaced event meant to inform the user. It may not require a decision.
_Avoid_: approval request when the user must decide

**Notification provider**:
A plugin or built-in contributor that polls for notifications and hands them to Station.
_Avoid_: event source when user-facing notification semantics matter

**Voice session**:
A speech-to-speech interaction with a voice provider.
_Avoid_: chat session when audio transport matters

**Terminal process**:
A Station-managed terminal with project, cwd, status, pid, exit code, history, and subprocess state.
_Avoid_: shell if Station tracks lifecycle

**Telemetry**:
OpenTelemetry counters, histograms, traces, and attributes that describe meaningful Station operations and outcomes.
_Avoid_: logging when the signal is intended for metrics

**Verification lane**:
A named, rerunnable command or test bucket that proves behavior.
_Avoid_: one-off smoke note

**Static gate**:
The verification gate covering rename inventory, lint, typecheck, manifest checks, and unit tests.
_Avoid_: docs-only check if type/unit failures can block it

**Full verification gate**:
The no-shortcuts gate that includes static checks and full Playwright coverage.
_Avoid_: quick test

**Generated artifact**:
A local-first file produced by Station, Veritas, Flow, Surface, Console emission, or verification. Generated artifacts must not be confused with source-owned standards.
_Avoid_: source doc unless it is intended for review

## Relationships

- Knowledge namespaces shape agent context inside projects.
- Scheduled jobs can produce scheduled runs, job logs, notifications, and receipts.
- Terminal processes can support agent work but are not evidence unless captured as command evidence.
- Telemetry describes operations; verification lanes prove behavior.
- Generated artifacts may support receipts but usually should not be edited like source.

## Flagged Ambiguities

**Notification / approval request**:
Notification informs. Approval request asks for a decision.

**Log / evidence / report**:
A log is raw output, evidence is evaluated support for a claim, and a report is a rendered presentation of evidence or run state.
