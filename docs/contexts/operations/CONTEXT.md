# Operations Context

Operations covers Station's local-first supporting systems: knowledge, scheduling, notifications, voice, terminals, telemetry, verification, and generated artifacts.

## Language

**Knowledge namespace**:
A named knowledge collection with a defined scope and retrieval or prompt-injection behavior. Project and personal knowledge have different owners; the term does not imply every collection belongs to a Project.
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
A configured job with a cron, interval or one-time schedule that can also be run manually. A normal job invokes an Agent; an external monitor observes its source and can request a bounded Task dispatch.
_Avoid_: cron string when Station behavior matters

**Scheduled run**:
A run produced by a scheduled job.
_Avoid_: interactive session

**Job log**:
The scheduler owner's execution record, including the state and any available attempt, output or error details. Missing output and indeterminate invocation are not successful execution.
_Avoid_: console output

**Notification**:
A stored attention item intended for the user, with its own status and optional actions. It may not request a decision. Storing, delivering and viewing it are separate events.
_Avoid_: approval request when the user must decide

**Notification provider**:
A plugin or built-in contributor with a stable source identity. Its optional poll supplies notifications; optional status/action hooks handle that source's updates. It is distinct from an OS/Web Push delivery channel.
_Avoid_: event source when user-facing notification semantics matter

**Voice session**:
A speech-to-speech interaction with a voice provider.
_Avoid_: chat session when audio transport matters

**Terminal process**:
A Station-managed terminal with project, cwd, status, pid, exit code, history, and subprocess state.
_Avoid_: shell if Station tracks lifecycle

**Telemetry**:
OpenTelemetry counters, histograms, traces and attributes describing observed operations. Defining an instrument does not prove a caller records it or an exporter delivered it.
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
A file or report produced by a tool. Some outputs are tracked and regenerated, such as documentation inputs for MCP; others are retained runtime evidence. Their origin and revision matter, and a generated report is not a protected source-owned standard.
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
| Stored notifications and source actions | [NotificationService](../../../src-server/services/notifications/notification-service.ts) | [Notification delivery design](../../design/notification-delivery.md), with its stated implementation limits |
| Desktop alert delivery | [Native feed consumer](../../../src-desktop/src/notification_feed.rs) | [Desktop alerts](../../guides/desktop-tray.md#desktop-alerts-while-the-window-is-hidden); OS results and user attention remain distinct |
| Voice session lifecycle | [VoiceSession](../../../src-server/voice/voice-session.ts) | [Voice examples](../../../examples/README.md) |
| Verification selection and completion | [Lane registry](../../../scripts/verification-lanes.mjs) | [Testing](../../guides/testing.md) |

Storage, dispatch, and physical delivery have different evidence. A queued
notification is not proof a phone displayed it; an executed check is not proof
its findings passed a gate.

## Flagged Ambiguities

**Notification / approval request**:
Notification informs. Approval request asks for a decision.

**Log / evidence / report**:
A log records observations. Evidence is used to support a particular claim. A report presents those records or an evaluation; rendering them does not establish their completeness or correctness.
