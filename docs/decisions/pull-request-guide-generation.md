---
status: current
---

# Pull request guide generation

## Decision

Generate shared, head-bound review tours through a tool-free managed model.
Keep guide writes under operator authority, including bound operator MCP
callers. Project and repository resolution stays in the existing pull request
route boundary; arguments cannot select arbitrary filesystem paths.

## Threat model

A repository member or pull request author can control source files, Git
configuration, PR text, and model output. That content must not execute programs,
read unrelated host data, acquire review authority, or publish fabricated line
anchors. A guide is advisory text, not an approval or an executable instruction.

## Controls and limits

Use Station's `requireLiveRepository` custody/config boundary and hardened Git
runner for a detached temporary checkout. Do not expose shell or file tools to
the model. Supply bounded diff and regular changed-file blobs, omit all review
conversations, and treat supplied text as data. No dependency installation,
repository script, checkout modification, or forge review write occurs.

Reject malformed or over-limit output and anchors outside actual parsed diff
lines or spanning hunks. Complete omitted-file coverage with a final stop that
explicitly says those files remain unexplained. Persist versioned, atomic
per-head records under a hash of the exact forge/repository/PR identity. Before
returning an old guide, strip its excerpts and line notes. The UI also checks
staleness. Generated prose remains untrusted text rendered through React.

Generation is opt-in and discloses model transmission in Settings and the user
guide. A server admits at most two runs and a tool batch has at most twenty
targets. Run status is process-local; completed guides persist. No new grants,
credential storage, execution permission, or human approval bypass is introduced.
The first slice intentionally restricts MCP to bound operator callers; broader
project-agent authority requires a separate ownership review.

## Evidence

The guide service tests use real isolated repositories to verify temporary
checkout cleanup, same-head coalescing, durable restart reads, file coverage,
invalid-output failure, and stale-anchor removal. MCP tests exercise the actual
registered tool schema and REST forwarding. Live model/provider qualification
is separate from deterministic seam evidence.
