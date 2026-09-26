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
A named command or test group that checks specified behavior. Its result proves
only what the selected checks actually exercised.
_Avoid_: one-off smoke note

**Static gate**:
Checks of source structure, types, formatting, contracts, and generated output.
The exact membership is defined by the current verification scripts, not this
context file.
_Avoid_: docs-only check if type/unit failures can block it

**Full verification gate**:
The canonical `npm run full:regression` promotion lane, run by hosted Nightly
and tagged-release workflows. Ordinary changes use focused evidence and
`npm run ci:fast`; see the [testing guide](../../guides/testing.md).
_Avoid_: quick test

**Generated artifact**:
A local-first file produced by Station, Veritas, Flow, Surface, Console emission, or verification. Generated artifacts must not be confused with source-owned standards.
_Avoid_: source doc unless it is intended for review

## Relationships

- Knowledge namespaces shape agent context inside projects.
- Scheduled jobs can produce scheduled runs, job logs, notifications, and receipts.
- Terminal processes can support agent work but are not evidence unless captured as command evidence.
- Telemetry describes operations; verification lanes check their declared scope.
- Generated artifacts may support receipts but usually should not be edited like source.

## Implementation route

| Responsibility | Owner | Reading |
| --- | --- | --- |
| Knowledge storage, retrieval, and context | [KnowledgeService](../../../src-server/services/knowledge/knowledge-service.ts) | [Knowledge](../../guides/knowledge.md) |
| Job ownership and run accounting | [SchedulerService](../../../src-server/services/scheduling/scheduler-service.ts) | [Monitoring](../../guides/monitoring.md) and [Starter Work](../../guides/starter-work.md) |
| Stored notifications and actions | [NotificationService](../../../src-server/services/notifications/notification-service.ts) | [Notification delivery design](../../design/notification-delivery.md), with its stated implementation limits |
| Voice session lifecycle | [VoiceSession](../../../src-server/voice/voice-session.ts) | [Voice examples](../../../examples/README.md) |
| Verification selection and completion | [Lane registry](../../../scripts/verification-lanes.mjs) | [Testing](../../guides/testing.md) |

Storage, dispatch, and physical delivery have different evidence. A queued
notification is not proof a phone displayed it; an executed check is not proof
its findings passed a gate.

## Flagged Ambiguities

**Notification / approval request**:
Notification informs. Approval request asks for a decision.

**Log / evidence / report**:
A log is raw output, evidence is evaluated support for a claim, and a report is a rendered presentation of evidence or run state.
