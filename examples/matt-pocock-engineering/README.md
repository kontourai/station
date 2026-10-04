# Station-curated Matt Pocock engineering collection

This ordinary Agent Plugin supplies five visual entry points: **Clarify an
idea**, **Clarify project decisions**, **Write a specification**, **Break a
specification into tickets**, and **Implement reviewed tickets**. Each can be
selected independently. Authored optional stage choices prepare the next draft
in the same conversation; they never send or implement automatically. The package
is Station-curated; Matt Pocock authored the upstream Skills, not these visual
interfaces, and no endorsement is implied.

The source is `mattpocock/skills` at
`d81f3a183412e71a5b1e84ca21bc1a35eea03a60`, under the retained
[MIT license](LICENSE-MIT). [Source review](SOURCE-REVIEW.json) records the
conservative dependency graph and gaps; [adaptations](ADAPTATIONS.json) records
the portable frontmatter changes. Every definition maps each bundled Skill to
its original path and revision. Immediate-child `skills/<name>/SKILL.md`
materialization follows ordinary Agent Plugins discovery; there is no core
special case for this collection.

With a CLI built from this source revision on Node 24:

```bash
# In this directory:
station plugin build
# Against a running local Station using an isolated home:
station plugin preview /absolute/path/to/matt-pocock-engineering
station plugin install /absolute/path/to/matt-pocock-engineering
```

Author validation has been executed. It establishes schema, portable Skill
parsing and pinned bundled bytes. One [recorded browser/model journey](qualification/browser-focus-board-20261003.json)
at source1bd clarified a local Focus Board idea with Codex, produced a reviewed
specification and published six local tickets after approval. Reload at source746
retained its three immutable stage snapshots. Questions used ordinary chat text;
this receipt does not qualify canonical questionnaire answers, later composer
changes, application implementation, physical devices or a released collection.
Only that observed [evaluation case](EVALUATION-CASES.json) passed; other planned
cases remain not-run. Native, rich-pane, registry and release evidence retain
their own scopes as explained in the
[author learning path](../../docs/guides/authoring-skill-experiences.md).

## Move an idea into engineering work

Start with a real idea. **Clarify an idea** delegates into `grilling`, which
asks the independent decision frontier, waits for answers, recomputes the next
frontier and ends only when the frontier is empty. It must wait for shared
understanding before acting. Environment facts belong to agent exploration and
subagents; a provider without that capability is unsuitable. The optional
visible decision summary is Station-added; upstream promises shared
understanding, not an exported summary.

Use **Clarify project decisions** when resolved terms should update the
project glossary and consequential choices warrant ADRs. It additionally loads
`domain-modeling`; glossary updates happen inline, while ADRs are offered only
under its three criteria. Project access and write permissions still apply.

Continue **the same conversation** by explicitly asking for `to-spec`, naming
the settled decisions. In a new conversation, supply the reviewed decision or
spec reference and actual supporting artifacts. The skill synthesizes current
context without another interview, explores the project glossary/ADRs, confirms
testing seams, writes its extensive source template and publishes to the
configured issue tracker. Missing tracker configuration stops for the user to
select `setup-matt-pocock-skills`; the interface does not invent configuration
or claim publication from draft prose.

Next explicitly select `to-tickets` and name the reviewed specification. It
reads the full reference/comments, drafts tracer-bullet vertical slices and
blocking edges, and quizzes the user about granularity/edges before publishing.
For local tracking it writes one file per ticket in dependency order; for a
real tracker it publishes real identifiers and relationships. It must not close
or modify a parent issue. The configured tracker, local files and actual
publication actions retain the agent's normal authority boundary.

Implementation is a separate user decision. After reviewing the work
breakdown, explicitly choose **Implement reviewed tickets**, supply the selected
ticket references and confirm Project, branch, tools and pre-agreed testing seams
before sending. This authored stage calls the bundled `implement` entry; it is
never an automatic transition from tickets.
It uses `tdd` where possible, checks the work, invokes `code-review` and commits
to the current branch. Installing or finishing a visual experience grants none
of these actions. Starting implementation does not reset reviewed decisions.
There is no automatic funnel or alternate session lifecycle.

## Source adaptations and limits

Upstream's `disable-model-invocation` frontmatter is outside the portable
Agent Skills SDK grammar. Adapted Skill files remove only that field; originals
are retained under `upstream/`, and `agents/openai.yaml` policies remain.
These are explicit-user entry points. Never automatically invoke setup,
implementation or another user-invoked Skill. The visual adapter preserves
selection and stop instructions; it does not establish enforcement of every
provider's implicit invocation policy. Inspect that provider's actual policy
support before using portable automatic discovery.

The conservative inspector includes setup/router references, so this package
bundles the full selected 16-Skill graph and the linked wizard template rather
than assuming only three wrapper files suffice. Templates may mention example
project paths or hypothetical slash routes; these remain source review leads,
not required tools. The source parser also reports the unselected upstream
`pr` Skill's nested metadata as incompatible; it is not installed here.

Some source dependencies create scripts/HTML reports, open browsers, use CDN
assets, run subagents, inspect Git history, or contact an issue tracker. Source
presence does not execute or qualify those paths. No template is executed
while authoring or validating. Setup asks before changing the project config.

The interview descriptor allows up to 12 canonical questions per rendered
round. This is a Station presentation descriptor, not the source frontier
limit. Larger or prose-only frontiers stay answerable in chat without dropping
questions. Guided/alongside presentation must preserve the same requests,
answers, decisions and artifacts. Definitions declare suitability, not grants.
