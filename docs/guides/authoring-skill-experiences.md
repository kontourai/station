# Author a visual skill experience

An experience is a reviewed introduction to bundled Skills. The
[public definition contract](../reference/skill-experiences.md) describes
inputs, expected outputs, interaction, provenance and limits. Its JSON files
ship in an ordinary Agent Plugin; authoring does not require a hosted converter
or an account. Runtime discovery and requests belong to the installed package
and canonical conversation, as described in the contract.

Use the [independent declarative example](../../examples/visual-skill-experience/README.md)
for an original Skill, or the
[Station-curated engineering collection](../../examples/matt-pocock-engineering/README.md)
for an attributed companion to an existing library. These examples require a
CLI with this source change. A workspace build or local tarball is diagnostic
proof; use registry metadata and a fresh external consumer to establish a
published release.

## Inspect the library and propose an interface

Pin the upstream revision before reading it. Obtain the source using its
normal distribution path; the inspector never fetches it, runs scripts,
installs dependencies or grants tools.

```bash
station plugin experience inspect /path/to/pinned-library --entries=grill-me,to-spec,to-tickets > inspection.json
```

The command emits bounded file bytes/digests, literal dependency edges,
references, setup material, scripts/assets, a source digest, gaps and an agent
authoring prompt. It indexes nested Skills by their parsed names and follows
literal Skill-tool calls and slash-name references. This deliberately collects
conservative leads: a path or router mention can look like a Skill invocation.
Referenced files outside a Skill’s directory contribute their literal calls to
that Skill’s dependency edges too. Shared references and reference cycles are
inspected without executing their contents.
A malformed Skill parser input is reported as a gap and indexed only if its
literal name is readable; packaging still uses the strict portable validator.

The bounds are 1024 files, 16 directory levels, 1 MiB per file, and 8 MiB of
selected source. `.git` and `node_modules` are excluded. File symlinks must
resolve to contained regular files; directory symlinks and special files are
refused. This is a local author boundary, not hostile concurrent filesystem
isolation. Binary assets have exact byte digests but the text view is only a
UTF-8 representation. Use a suitable asset viewer during review.

Give the selected agent `inspection.json`, the v1 contract/schema and the
emitted `authoringPrompt`. Ask it to propose ordinary manifest declarations,
Skill materialization and JSON definitions in an author-owned directory. The
agent must review the full dependency graph, including indirect prose and
dynamic boundaries. Discovery cannot prove that graph complete. Missing tools,
conflicting output promises, dynamic discovery and opaque scripts remain gaps
until reviewed; unsupported behavior must remain visible in the definition.

Classify each pattern as interview, transform or inspection. Mixed workflows
can offer independent entry points, with explicit user-selected continuations
in the same conversation. V1 has no automatic stage executor. Rich interfaces
use their public extension owner; an ordinary Workspace Pane alongside a
conversation does not by itself establish experience-bound rich rendering.

Keep these distinctions in every proposal:

- **Skill-declared:** a source requirement, traced to exact source lines.
- **Reviewer-inferred:** an interpretation, with its reasoning and uncertainty.
- **Station-added:** an added input, control or presentation, identified as such.

Do not infer that every interview produces an exported summary, every draft
was published, or an installed definition authorizes writes. Preserve the
source's confirmation stops and unavailable-environment behavior.

## Review, preview and evaluate

Edit the proposal and inspect its ordinary plugin files. Run `station plugin
build` in the author directory: the existing author validator checks schema,
identity, defaults, dependency references, actual Skill parsing and digests.
No JavaScript bundle is needed for a purely declarative package.

Use `station plugin experience review` without a receipt to print the source
and package digests for the proposed revision:

```bash
station plugin experience review /path/to/plugin --library=/path/to/pinned-library --entries=grill-me,to-spec,to-tickets
```

The package digest uses the existing plugin-tree format over the complete
bounded distributable directory, including notices, definitions, rich assets,
Skill references, scripts, evaluations and symlink topology. Git metadata is
excluded. Review a clean package staging directory; dependency installation
directories count toward the bounds and should not be part of this payload.
Keep the review receipt outside that directory to avoid self-reference. The source digest covers the inspected graph
and its gaps, not a remote upstream repository identity.

Install the draft through ordinary Plugin preview/consent in an isolated
Station home and select a capable agent. Preview representative inputs, inspect
source/context, and exercise both a useful run and a refusal or confirmation
stop per experience. Use real canonical conversations and actual output
references. A renderer must project real requests; formatted question prose
alone is not an authorized request. Record transcript bytes in a local
`evaluations/` directory inside the author package. Keep private transcripts
out of public packages or use sanitized, clearly labelled examples.

Write an external receipt implementing
[`SkillExperienceReview`](../../packages/shared/src/skill-experience-workflow.ts):

```json
{
  "sourceDigest": "<inspection digest>",
  "packageDigest": "<proposal digest>",
  "reviewer": "<reviewer name>",
  "decision": "revise",
  "evidence": [
    {
      "experienceId": "my-experience",
      "pointer": "/inputs/0",
      "origin": "skill-declared",
      "explanation": "The source requires this input.",
      "source": { "path": "skills/my-skill/SKILL.md", "startLine": 7, "endLine": 9 }
    }
  ],
  "gapDispositions": [
    { "gap": "<exact inspection gap>", "disposition": "<review outcome and limit>" }
  ],
  "evaluations": [
    {
      "experienceId": "my-experience",
      "kind": "representative",
      "scenario": "<actual input and prerequisites>",
      "expected": "<source obligations>",
      "observed": "<actual result and artifacts>",
      "status": "not-run",
      "transcript": { "path": "evaluations/run.md", "sha256": "<exact byte digest>" }
    }
  ]
}
```

The receipt has a closed runtime grammar: unknown fields, unsupported provenance
classes, duplicate evidence keys, overlong strings and oversized arrays are
refused. The CLI reads a contained regular receipt file of at most 64 KiB and
refuses special files without a blocking open.

Supply evidence for every input, output and required-context item, plus
`/interaction` and `/capabilities`. Skill-declared evidence needs a valid source
span; item provenance must agree with the definition. Give every emitted gap a
disposition. Include both `representative` and `refusal-stop` evaluations for
every definition. An empty observation, missing transcript, changed bytes,
`not-run`, failure or `revise` decision refuses author approval. Set `approve`
only after reviewing the concrete results.

```bash
station plugin experience review /path/to/plugin --library=/path/to/pinned-library --entries=grill-me,to-spec,to-tickets --receipt=/path/to/review.json
```

This checks review assertions, source spans and retained transcript bytes. It
cannot determine whether a reviewer told the truth or whether a model behaved
correctly. `author-approved` is not installed runtime, native/device or released
qualification. Keep those receipts separate. Loading an installed definition
uses its accepted JSON and never reruns this conversion.

## Package, update and qualify independently

Use the public [Agent Plugins packaging/install path](../reference/agent-plugins.md)
and [CLI build/install commands](../reference/cli.md). A companion package must
retain source attribution, license/notices, full pinned repository mappings and
an adaptation record. Describe Station curation accurately; do not imply an
upstream author endorsed the visual interface. Upstream-owned extensions can
use the same public contract without a companion or core allowlist.

When source bytes, dependencies, behavior or an interface change, rerun
inspection and compare the old/new files, edges, gaps and definitions. Record
which behavior changed and whether the controls/outputs still preserve its
obligations. The old receipt refuses a source/package delta; updating hashes
alone does not replace semantic review. Increment definition/package versions
and evaluate again. Existing conversations and historical outputs remain
canonical context; never silently replace reviewed decisions after an update.

To qualify a published consumer, create a clean directory outside this
repository on Node 24, obtain exact published CLI/contracts/shared versions,
and copy the original example into that directory. Run the same inspect,
build, review and install commands without workspace links or imports from
Station internals. Retain registry metadata, tarball integrity, package versions,
consumer commands and an installed canonical run. Local `npm pack` tarballs can
exercise public exports before publication, but cannot establish registry
availability. Native/mobile, reload/resume, accessibility, stale requests and
approval denial remain separate end-to-end qualification responsibilities.
