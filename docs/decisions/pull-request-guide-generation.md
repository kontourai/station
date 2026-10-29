---
status: current
subject: Generate shared pull request guides without model execution tools
decided: 2026-10-17
evidence:
  - kind: commit
    ref: 86921a734ad
  - kind: doc
    ref: docs/user/pull-request-guides.md
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

Use Station's `readProjectRepository` custody/config snapshot and hardened Git
runner to read immutable blobs. Never materialize a temporary checkout: it is
unnecessary for a tool-free model and could execute operator-global smudge
filters selected by attacker-controlled attributes. Pin diff quoting, prefixes,
color, external-diff and text-conversion options explicitly. Do not expose shell or file tools to
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

The guide service tests use real isolated repositories to verify
blob-only reads with global-filter controls, same-head coalescing, durable restart reads, file coverage,
invalid-output failure, and stale-anchor removal. MCP tests exercise the actual
registered tool schema and REST forwarding. Live model/provider qualification
is separate from deterministic seam evidence.

Run-status polling is process-local and does not read a forge snapshot. Admission
checks capacity before a costly snapshot and again before starting generation.
Current-head guides are reused unless force is explicit, and a different head
cannot silently join an older run. Check the exact pretty-printed document size
before publishing it so every admitted write remains within the read limit.

## Structured generation and excerpt bounds

Station's framework interface takes the schema in `structuredOutputSchema`.
VoltAgent 2.10 requires the schema as its second argument and generation options
as its third; the adapter translates the interface and refuses a missing schema.
Strands 1.19 requires Zod, so its adapter converts AI SDK wrappers through their
JSON Schema representation. Registered-agent invoke uses the raw VoltAgent API;
global invoke uses Station's wrapper interface.

Restoring this adapter means configured approval guardians begin receiving model
verdicts: valid allow/deny/defer decisions now reach the existing policy. Previously
those calls failed before model invocation and deferred. Normalization still
rejects malformed decisions to defer; policy, grants, modes and prompts do not
change. Title generation and session summaries also begin using model results.
Global structured invoke already supplied the native schema as the second argument,
so it could produce structured output; its third-argument options were discarded
by the wrapper. Its formatting run now preserves conversation and user identity.

Expose all scalar and collection bounds in the structured schema and prompt.
Describe the inclusive excerpt rule (`end - start + 1 <= 25`) in the schema as
well as the prompt, and validate it with Zod and normalization. Native JSON Schema
cannot express this relationship between two fields, so provider schema support
alone does not guarantee compliance. A 36-line response is refused with the fixed
25-line failure, including when the AI SDK rejects it before normalization.
Reject the whole run rather than silently dropping the excerpt: its stop's notes
and narrative may depend on that range, and a partial tour would conceal the
failure. Nothing is published on failure; any prior guide remains intact. Valid
guides still cover every changed file through explicit anchors/files or the final
unexplained-files stop.


## Preserve validation failures without automatic retries

Disable VoltAgent's per-generation retry loop for review guides (`maxRetries: 0`).
The default loop retries schema failures without corrective input, spends the same
180-second service budget, and returns its last error. That can replace an earlier
25-line failure with a generic schema error or a timeout after several long calls.
A guide now makes one generation attempt and preserves that attempt's specific
validation failure. This chooses zero automatic corrective retries, within the
limit of at most one, rather than paying for another deterministic failure.
Operators can explicitly Rewrite or choose another model. Other generation
callers and their retry behavior are unchanged. Existing preparation, cancellation
and service deadline checks still bound the entire run.
