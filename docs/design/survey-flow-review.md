# Survey-backed Flow review

Station composes canonical Survey review sessions with existing Flow gates through
the public Flow Agents adapter. It does not construct Survey input, derive trust
bundles, interpret decisions, or implement continuation rules.

An integration writes canonical session projections to
`<workspace>/.station/survey-review-sessions.json`. The envelope contains only
Station routing fields (`projectSlug` and the opaque `reviewSessionRef`) plus the
public Flow Agents binding fields (`projectionSource` and
`workflowSubjectRef`). `record`, `events`, `currentSnapshot`, and
`currentEventCount` retain their published Survey shapes.

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

Stale run heads, stale Survey snapshots, foreign subjects, projection-source
mismatches, duplicate opaque references, and lifecycle mismatches fail closed in
the owning public contracts. The same Flow definition and session projection can
therefore be resumed from Station or any local harness using the same Flow Agents
adapter. Domain integrations, including a synthetic tax-document harvest adapter,
produce ReviewItems; Station remains domain-neutral.

Telemetry records only operation outcomes and counts under
`station.survey_flow_review.*`; it never records subjects, session references, or
review content.
