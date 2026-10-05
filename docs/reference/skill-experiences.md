# Visual skill experience authoring contract

The v1 contract covers author validation, admitted installed inventory and
explicit foreground use in canonical Sessions. New Chat presents installed
experiences through the ordinary selected Agent, model, Project and composer.
Guided, alongside and chat views share the same Session, question controls and
outputs. An experience declaration supplies no execution authority by itself.

The [Agent Plugins contract](agent-plugins.md) owns portable Skills and MCP.
This contract adds an inert Station-owned description of how to approach one
or several bundled Skills. It supplies no code, model selection, tool grant,
alternate agent lifecycle, or Flow execution authority.

## Declare a definition

Add an optional `experiences` array to `extensions["io.kontourai.station"]`
in `plugin.json`:

```json
{
  "schemaVersion": "1.0",
  "experiences": [
    {
      "version": "1.0",
      "id": "stress-test-idea",
      "source": "./io.kontourai.station/experiences/stress-test-idea.json"
    }
  ]
}
```

The namespace has at most 32 declarations. Each references one JSON file
directly inside `io.kontourai.station/experiences/`, using a lowercase
hyphen-separated filename. IDs and file references must be unique. The owning
portable manifest must have a version; its validated name/version supplies the
package identity, without a second copy in the definition.

Definitions use
[`SkillExperienceDefinitionV1`](../../packages/contracts/src/skill-experience.ts)
from `@kontourai/station-contracts/skill-experience` and the local
[v1 schema](../../schemas/agent-plugins/skill-experience-1.0.schema.json).
The `$schema` URI identifies the contract; loading validation never fetches it.
The repository file is the schema authority for this source checkpoint; this
document does not assert that the URI is already hosted or the package released.

| Field | Meaning |
| --- | --- |
| `$schema`, `schemaVersion` | Exact supported schema identity and `1.0` |
| `id`, `version` | Identity matching the declaration and author-managed definition revision |
| `title`, `purpose`, `example`, `authors` | User-facing introduction and attribution |
| `skills` | Exact bundled Skill paths/digests, local dependency references, optional upstream mappings |
| `entrySkillId` | Explicit entry for a definition containing several Skills; a one-Skill definition may omit it |
| `transitions` | Optional labelled, attributed links to other declared experiences in this same package; each requires user selection |
| `requiredContext` | Project/conversation prerequisites, with explicit required or optional status |
| `capabilities` | Conversation, Project read, file read, artifact output suitability requirements |
| `inputs` | Bounded text, single-choice, or attachments; required status, defaults and constraints |
| `interaction` | Interview, transformation, or inspection; optional adaptive round descriptors, stop conditions and unsupported behavior |
| `outputs` | Expected markdown, JSON, files, or decision summary; required or optional status |
| `presentation` | Guided/alongside modes and a default contained in those modes; optional `richView` links a same-package plugin-component Workspace Pane |

Input IDs reserve `constructor`, `prototype` and `__proto__`; author validation
reports an explicit refusal before such a definition enters inventory. Scalar
and attachment maps use own JSON keys, so omitted optional/default inputs never
inherit object members.

Input, context, and output provenance distinguishes `skill-declared` (with an
existing local `skillRef`), `reviewer-inferred`, and `station-added`. Each needs
an explanation. Those are author assertions to review, not Station approval or
evidence that an output will occur. Unknown fields, component kinds, and
schema versions fail validation rather than being interpreted as executable
instructions. Required and optional requirements use the same closed grammar.

## Bind Skills and source revisions

Each Skill has a local ID, its portable name, the exact
`./skills/<name>/SKILL.md` path, and the SHA-256 of its bundled bytes.
Author validation reads that actual file, checks containment, compares
the digest, and uses the same Agent Skills SDK parser as portable discovery
to verify the Skill content and frontmatter name. It rejects missing files, mismatched digests, duplicate identities,
and unknown or self dependency references. It does not run the Skill or prove
that its prose agrees with the visual definition.

Optional `upstream` records an HTTPS repository, full 40-character Git commit,
and repository-relative original file path. This maps a Skill repackaged from
a nested library to its portable immediate-child location. The author build
does not fetch or authenticate upstream. Every relevant called Skill should
be bundled, independently pinned, and named in `dependsOn`; indirect scripts
and references still need review. Author expectations do not prove dependency discovery is complete. Runtime
admission additionally checks the whole installed package tree against its
admitted content digest, including scripts and references bundled in that tree.

These expectations are separate from host-observed acquisition, signature,
installation generation/incarnation, or trust. Runtime activation must bind to
the installed package artifact and its current generation, never resolve an
experience by an unqualified global Skill name. Author-supplied digests do not
grant access or identify the currently installed revision.

## Validate through the author build

`station plugin build` uses
[`readPluginBuildManifest`](../../packages/shared/src/build.ts), which invokes
the [author validator](../../packages/shared/src/skill-experience-author.ts)
before bundling. Definitions are limited to 64 KiB; each referenced Skill to
1 MiB. Regular files must stay physically inside the package, including after
symlink resolution. The shared regular-file opener refuses FIFOs and other
nonregular inputs without a blocking open; size/type checks still use the open
descriptor. POSIX FIFO cases run in bounded build children; they are skipped
on Windows, where this does not establish named-pipe behavior. Invalid JSON/schema, escaping or missing files, identity
conflicts, invalid defaults, unknown Skill references, and source changes
produce file/field-specific errors. The handwritten
[example](../../examples/visual-skill-experience/README.md) uses this same path.

This is a local author boundary, not hostile concurrent filesystem isolation
or runtime admission. The existing portable runtime parser can accept a valid
declaration without reading its files; the installed inventory independently
repeats source validation after package admission.
It continues to own portable Skill parsing and availability.

Adaptive interview declarations name supported answer kinds and a maximum
question count per round; they do not predict future questions. Actual questions
must come from canonical harness input requests when the engine supplies them. Engines without
that bridge ask in chat and receive ordinary composer replies. The renderer uses
their exact request/thread/event identities and answers; model prose alone
cannot create an authorized input request.

## Read installed experiences

`GET /api/skills/experiences` uses the existing Skill routes and returns
`SkillExperienceInventoryV1`: validated definitions and named diagnostics.
[AgentPluginLoader.listSkillExperiences](../../src-server/services/plugins/agent-plugin-loader.ts)
reads ordinary installed Agent Plugins through the existing materialization and
admission journal. Pending activation, retirement/revocation, missing custody,
changed package bytes, invalid definitions, unsupported versions, missing local
dependencies, and escaping source files cannot publish an available entry.
Legacy direct packages need the existing managed activation path first.

The read holds the existing package-content lease and uses yielding whole-tree
digest observations before and after definition validation. It does not import
package code or acquire grants. The returned identity includes the observed
plugin ID/version, experience ID, installation incarnation, materialization,
whole-package content digest, and SHA-256 of `JSON.stringify` of the validated
definition. This normalized definition digest identifies the returned snapshot;
it is separate from each bundled Skill's byte digest. A catalog snapshot never
authorizes a later execution; that owner must revalidate its identity at start.

[SkillService](../../src-server/services/agents/skill-service.ts) applies the
current discovered Skill scope and precedence. Every named Skill must still
resolve to the same owning package/version. A local or Project override makes
the pinned visual experience unavailable instead of substituting new instructions.
Experience identity is qualified by its owning package, so two packages cannot
silently claim one unqualified run identity. This endpoint describes the current
runtime discovery scope; it does not accept an arbitrary Project or grant context.

The [route tests](../../src-server/routes/agents/__tests__/skill-experiences.routes.test.ts)
exercise real local installation, activation, retirement, source mutations,
malformed definitions, an ordinary third-party name, and local precedence.
They establish the controlled API/inventory path, not a model run, browser or
native renderer, historical resume, or release qualification.

## Compatibility and state decisions

- **Files:** use explicit manifest references, not scanning or executing an
  arbitrary namespace directory. Keep visual definitions separate from Skills.
- **Evolution:** the optional namespace field is additive for current Station
  schema `1.0`. Older Station validators with a closed schema may disable the
  whole Station extension on seeing `experiences`; portable Skills and MCP stay
  independently consumable. Authors targeting those hosts should omit the
  declaration or publish a compatible package version. Other Agent Plugins
  clients can ignore the namespace. The inventory's optional `executionContract: "1.0"` advertises foreground
  support only after runtime composition wires the source owner and Session
  store. Clients must refuse execution when that marker is absent: an older
  foreground schema can strip an unknown experience field.
- **Updates:** review the definition when bundled Skill bytes, dependencies, or
  behavior changes, then update its digest/version and the package version.
  A matching digest proves only those file bytes, not semantic review.
- **Session ownership:** conversation, answers, decisions, artifacts, and real
  request lifecycle belong to the canonical session. Guided/alongside selection,
  expanded sections, and navigation are presentation state. Unsatisfied
  prerequisites refuse before the provider turn; missing source or snapshot
  authority never becomes an ordinary unqualified Skill invocation.
- **Conversion:** agent-assisted conversion can produce an author definition,
  but that candidate still needs semantic review and source/digest validation.
  This runtime does not infer future stages, question rounds or outputs.

The [author build tests](../../packages/shared/src/__tests__/skill-experience-author.test.ts)
exercise real files, schema validation, source binding, and refusal diagnostics.
They do not establish installed runtime, native, model, or release behavior.


## Start and continue through the canonical Session

`POST /api/orchestration/chat` accepts optional `skillExperience` with the exact
installed `identity`, scalar `inputs`, optional `attachmentInputs` and optional
`expectedPreviousInvocationEventId`. The request still names the selected
Agent/model/workspace through the ordinary foreground target. A `clientTurnId`
is required. Environment resolution honours the Project's default; local
foreground execution is supported, while saved/remote execution is refused
before Session or provider effects.

[SkillExperienceRuntime](../../src-server/services/orchestration/skill-experience-runtime.ts)
checks the current invocation, declared input IDs/defaults/constraints, actual
Project/conversation context and canonical attachment indices. Text constraints
count Unicode code points. Attachments name indices in the hydrated outgoing
attachment array, never paths or alternate custody. Initial and continued model
context carries the role-to-index assignments and declared labels, explicitly
referring to the original invocation's attachments. Unknown roles, duplicate
indices, missing required inputs and out-of-range indices fail. The entry Skill
and its explicitly declared dependencies supply bounded instructions; no
alphabetical entry is inferred for a multi-Skill definition. Source references can form cycles; a finite visited-set closure delivers each
declared dependency once. Their combined
context is bounded to 128 KiB and refused rather than truncated above it.

Direct providers receive that pinned context in model input while retaining the
ordinary display prompt. The Station engine carries it as a private companion
on its existing authenticated turn-correlation handoff and composes it only at
the model-facing choke point. Each continuation re-delivers the same admitted
context. This bridge does not resolve a global Skill alias or depend on Claude's
opt-in Skill materialization. Referenced scripts/files remain at the pinned
package resource root and still require ordinary Agent tools and permissions;
unavailable resources must remain visible rather than becoming claimed work.

The existing package-content lease and admission journal bind package root,
incarnation, materialization, whole-package digest and definition digest at the
provider effect. [SkillService](../../src-server/services/agents/skill-service.ts)
also preserves discovered Skill precedence. Ordinary send, steer and accepting a
canonical request all recheck the current pinned source; denial, cancellation,
interruption and Stop keep their canonical settlement paths. Tool and model
permissions remain the Agent's ordinary authority.

Transitions are explicit links within one installed package revision. The next
selection names the latest canonical invocation event; the host checks that the
old definition actually declared the target. Selecting a stage fills Station's
composer. Sending it is a separate user action. Cycles in a stage graph are
permitted user-selected journeys, rather than an automatically executing graph.

## Retain and read invocation history

The same [EventStore](../../src-server/services/orchestration/event-store.ts)
retains immutable presentation snapshots beside canonical Session events. The
snapshot contains the exact inert definition, validated initial inputs, source
identity, client turn and previous invocation. A bounded server-owned
`stationSkillExperience` reference is attached to the actual accepted
`turn.started` through the existing exact turn attribution mechanism. A
snapshot written before a refused turn is not an invocation and is never exposed
as one. Provider-supplied references are stripped.

`GET /api/orchestration/sessions/:threadId/skill-experience` returns
`SkillExperienceSessionViewV1`: `current`, descending `history`, `hasMore` and an
optional `nextCursor`. `limit` is 1–100 (default 20); cursor is the last returned
canonical event ID. Existing conversation lineage carries the invocation across
child execution Sessions. Session read authorization applies to every exposed
source thread, and each row retains its actual thread/turn/event identity.

Availability is `available`, `source-unavailable` or `snapshot-unavailable`.
Removing or replacing a package preserves readable immutable history while
refusing further source-backed effects. A missing, corrupt or incompatible
snapshot remains an explicit unavailable row, never reconstructed from today's
package or model prose. Deliberate Session deletion removes its snapshots in the
same deletion transaction. Snapshot storage is presentation data; commands,
requests, turns, decisions and outputs remain canonical Session facts.

## Native preparation and display

An unsent chat retains source identity and scalar inputs in the existing scoped
draft. Reload restores a bounded display preview, not author instructions or
execution authority. SDK feature responses are checked by the canonical reader, imported statically
into the client entry;
Send refetches installed inventory and checks the captured complete preparation
after asynchronous composer work. A changed preparation is retained for review.

Attachment role choices use existing composer client IDs. The sender maps them
to indices in the actual outgoing staged references; unassigned ordinary files
can remain in the same message. Recorded stages show role labels and original
turn file positions. The canonical transcript owns file contents and viewing.
Switching guided, alongside and chat presentation retains the same conversation,
questionnaire drafts and composer controls.

## Add an isolated rich pane

Optional `presentation.richView` is
`{version: "1.0", kind: "workspace-pane", descriptorId}`. Author validation requires
that descriptor to be a declared plugin-component Workspace Pane with the same
package provenance. The host uses the existing catalog occurrence and Plugin
Registry generation checks, plus the immutable invocation's exact installed
identity. A missing pane, permission or valid source falls back to the ordinary
guided/chat presentation.

The optional [PaneSkillExperienceHost](../../packages/contracts/src/workspace-pane-host-contract.ts)
member supplies only `read`, `answer` and `continue`. The placement fixes Session,
invocation event and package identity outside frame parameters. It exposes the
immutable view and bounded non-secret pending questionnaires, rather than
transcripts, credentials, arbitrary API paths or a new run store. An answer
uses the exact canonical request event. A continuation only stages a declared
next experience for user review.

Rich read and answer calls bind `expectedSkillExperience: {identity, eventId}`.
The server rechecks that exact current invocation and holds the fresh
`agents.invoke` grant through the effect. Ordinary user chat controls omit this
frame admission field. Bundle delivery also checks pinned
incarnation/materialization/content digest and the current grant. The existing
frame WindowProxy/origin pin, downlink allowlist and document lifetime remain
in force.

The [independent rich example](../../examples/rich-skill-experience/README.md)
builds a standalone DOM pane without a core component allowlist or server
module. It uses the public workspace-pane transport producer in the isolated
document. This qualification does not assert that ordinary React components or
authenticated SDK hooks are available inside that sandbox.

Owner tests cover controlled installation, real foreground target resolution,
provider-bound admission, retained history, authorization, frame identity and
a separately built rich package. Live model runs, browser/native journeys,
released SDK availability and promotion receipts remain separate evidence.
