# Visual skill experience authoring contract

**Status: authoring and installed inventory.** The v1 public types, local JSON
schemas, author build validation, and admitted installed inventory are implemented.
Installing this declaration does not yet expose an experience in New Chat or
render a guided workflow. Canonical session integration is tracked in #3131;
stage composition and historical run compatibility remain work in #3129.

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
| `requiredContext` | Project/conversation prerequisites, with explicit required or optional status |
| `capabilities` | Conversation, Project read, file read, artifact output suitability requirements |
| `inputs` | Bounded text, single-choice, or attachments; required status, defaults and constraints |
| `interaction` | Interview, transformation, or inspection; optional adaptive round descriptors, stop conditions and unsupported behavior |
| `outputs` | Expected markdown, JSON, files, or decision summary; required or optional status |
| `presentation` | Guided/alongside modes and a default contained in those modes |

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
and references still need review. V1 does not pin a complete transitive package
tree or prove dependency discovery is complete.

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
declaration without reading its files; the installed inventory independently repeats source validation after package admission.
It continues to own portable Skill parsing and availability.

Adaptive interview declarations name supported answer kinds and a maximum
question count per round; they do not predict future questions. Actual questions
must come from canonical harness input requests. A future renderer must use
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
  clients can ignore the namespace. There is no capability negotiation yet.
- **Updates:** review the definition when bundled Skill bytes, dependencies, or
  behavior changes, then update its digest/version and the package version.
  A matching digest proves only those file bytes, not semantic review.
- **Session ownership:** conversation, answers, decisions, artifacts, and real
  request lifecycle belong to the canonical session. Guided/alongside selection,
  expanded sections, and navigation are presentation state. V1 declares these
  boundaries; it introduces no persistence format or reducer.
- **Deferred:** stage graphs, optional stage composition, transitions, rich
  custom/MCP App components, runtime grants, conversion, run snapshots, and
  historical replay compatibility require their owning later implementation.

The [author build tests](../../packages/shared/src/__tests__/skill-experience-author.test.ts)
exercise real files, schema validation, source binding, and refusal diagnostics.
They do not establish installed runtime, native, model, or release behavior.
