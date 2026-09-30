# Survey-backed Flow review

> **Reading status: current composition note.** The
> [Station service](../../src-server/services/flow/survey-flow-review-service.ts)
> calls the public Flow Agents and Survey adapters; the
> [project Flow routes](../../src-server/routes/evidence/flow-runs.ts) expose
> the operations below and return 503 when the review provider is absent.
> Source wiring is separate from a successfully resumed review or cross-harness
> compatibility test.

Station composes canonical Survey review sessions with existing Flow gates through
the public Flow Agents adapter. It does not construct Survey input, derive trust
bundles, interpret decisions, or implement continuation rules.

An integration writes canonical session projections to
`<workspace>/.station/survey-review-sessions.json`. The envelope contains only
Station routing fields (`projectSlug` and the opaque `reviewSessionRef`) plus the
public Flow Agents binding fields (`projectionSource` and
`workflowSubjectRef`). `record`, `events`, `currentSnapshot`, and
`currentEventCount` retain their published Survey shapes.

The following illustrates the envelope only. The empty `record` and
`currentSnapshot` objects stand in for canonical Survey values; they are not
a runnable review session or evidence that a gate is ready to continue.

```json
{
  "sessions": [
    {
      "reviewSessionRef": "review:example:1",
      "projectSlug": "example",
      "projectionSource": "example.harvest",
      "workflowSubjectRef": "public-record:entity-123",
      "record": {},
      "events": [],
      "currentSnapshot": {},
      "currentEventCount": 0
    }
  ]
}
```

The project Flow API exposes three composition operations:

- `GET /api/projects/:slug/flow/reviews` presents canonical Survey state.
- `POST /api/projects/:slug/flow/runs/:runId/reviews/discover` discovers
  exact-head-bound missing work through Flow Agents.
- `POST /api/projects/:slug/flow/runs/:runId/reviews/continue` resolves the
  opaque session reference and delegates attachment, evaluation, and resume to
  Flow Agents and Flow.

Station checks the envelope's Project binding and requires exactly one match
when resolving an opaque review reference across known Project stores. Flow
Agents, Survey and Flow own the run-head, snapshot, subject, projection-source
and lifecycle checks. Per-Project route failures return 400; an absent review
provider returns 503. The cross-Project queue separately reports unavailable
Projects while retaining healthy results. A missing workspace or session file
is an empty state, not a completed review.

Other local harnesses can compose those same public adapters. That shared
contract does not by itself establish a successful cross-harness continuation.
Domain integrations, including a synthetic tax-document harvest adapter,
produce ReviewItems; Station remains domain-neutral.

The `station.survey_flow_review.*` metrics record counts with bounded outcome
or unavailable-reason labels, without subject, session-reference, or review-content
labels. This describes those instruments, not every diagnostic log.
