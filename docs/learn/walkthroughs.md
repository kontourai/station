# See Station in use

These captures put the architecture next to the application. They use isolated
Station instances and sample data. Each caption distinguishes persisted behavior
from a controlled response or provider fixture. The source files and capture
revisions are recorded in [the media manifest](media.json).

## Projects and Tasks

A Project gives work a workspace and a durable identity. Here, the Project
contains a saved Task even though no Agent Session has started. That distinction
matters: work can exist before an engine is ready to execute it.

![A Project with a saved Task and workspace details.](media/project-with-task.png)

The Task's shared document and conversation keep revisions and discussion with
that work. In this example a person saved a document; the room history records
revision evidence. This does not demonstrate an external Agent editing alongside
them. The editor's current size and the clipped heading are visible in the capture.

![A saved shared Task document and its revision history.](media/shared-task-document.png)

Continue with [Starter Work](../guides/starter-work.md),
[shared working state](../design/shared-working-state.md), and the
[Task room acceptance boundaries](../reference/project-task-room-collaboration-acceptance.md).
The [Task room runtime](../../src-server/services/orchestration/project-task-room-runtime.ts)
owns the server composition.

## Connections

Model connections let Station's engine use a model service. Engine connections
reach an agent app that owns its own loop. The tabs separate those responsibilities.

This screenshot uses **sample API responses**. Its Ready label shows how that
state is presented; it is not a successful test against a live model service.
The detail pane exposes the endpoint, chosen model, last check and test action.

![The Models page with an example local connection selected.](media/connections-models.png)

Read [Connections](../guides/connections.md) for the readiness states and
[smoke confidence](../reference/agent-smoke-confidence.md) for what an explicitly
requested test establishes. The [connection form](../../src-ui/src/views/provider-settings/ProviderConnectionForm.tsx)
is the UI owner; the [connection service](../../src-server/services/connections/connection-service.ts)
owns runtime observations.

## Inspect an approval

An attention item can point to an exact pending request. **Inspect request**
opens its scope and available responses. **Request identity** exposes the
underlying identifiers; opening this panel does not approve the action.

![A request inspector with Deny and Approve once actions.](media/inspect-request.png)

This example uses a controlled provider behind real request routes and an event
store. It inspects a synthetic file-read request without deciding it or contacting
an external provider. In ordinary work, read the request before choosing a response;
a changed or unavailable request needs a fresh inspection.

Continue with [approval and receipt inspection](../guides/starter-work.md#inspect-approval-and-review-evidence)
and the [Session API](../reference/session-api.md). A request decision authorizes
an action; it is not a review of the resulting work or a passed gate.

## Follow the implementation

Use the [learning branches](README.md#reading-branches) to move from a scenario to
its modules and source. The [repository knowledge graph](../guides/repository-knowledge-graph.md)
connects those explanations to referenced code, tests and decisions. A screenshot
or graph link is evidence to inspect, not proof of every platform or failure path.
