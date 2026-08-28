# ADR-0016: Merge Playbooks into Skills, behind a boot flag

Status: accepted, with the flag clause SUPERSEDED BY OWNER DECISION (see
"Superseded: no flag, no aliases" below)
Date: 2026-08-21

## Superseded: no flag, no aliases (owner decision, slice 4)

Everything below records the shape slices 1–2 were built to. Before slice 4 the
owner ruled that Station is PRE-RELEASE and therefore takes **no legacy support,
no compat flag, no alias window**:

- `STATION_SKILLS_MERGE` / `STATION_FEATURES=skills-merge` is **deleted**. The
  merged behaviour — in-place plugin command skills, skills as the one authored
  concept — is unconditional, and `GET /config/app` no longer carries
  `skillsMerge`.
- `/api/playbooks` and `/api/prompts` are **deleted**, not aliased, along with
  `PromptService`, the prompt scanner, the SDK playbook client and hooks, the
  `station playbooks`/`prompts` CLI verbs, and the `*_playbook`/`*_prompt`
  station-control tools. The `Playbook`/`Prompt` contract types and
  `agent.prompts` are gone: an agent payload naming `prompts` is a **400 schema
  rejection**, not a silent drop.
- `task.playbookId` is renamed to `task.skillName` and the graph relation
  `uses_playbook` to `uses_skill`, with no alias.
- The boot-time auto-migration is **deleted**. The only remaining reader of the
  legacy `<home>/prompts/prompts.json` format is
  `station doctor --migrate-playbooks [--dry-run]`, a one-shot helper that
  writes skills through the same seams; its legacy row shape is declared inside
  that module rather than in the shared contracts.

The word "playbook" survives in exactly three places, all of them accurate
history rather than live vocabulary: this ADR, the `migrated-playbook` skill
origin, and the name of that doctor flag.

## Context

Station shipped two things that are the same thing. A **playbook** is a named
body of text a user can run as a `/command`; a **skill** is a named body of text
an agent can activate from a catalog. They have separate stores
(`<home>/prompts/prompts.json` vs `<home>/skills/<name>/SKILL.md`), separate
identities (a UUID vs a directory name), separate routes, separate UI tabs, and
separate MCP tools — and a user who wanted one had to guess which.

Slice 1 (archive#3665) gave skills the affordances playbooks had: `command`
(`enabled`/`name`/`global`), declared `variables`, run/outcome counters in a
side store, `legacyIds` and `origin`. This slice moves the DATA and the callers.

## Decision

`<home>/prompts` folds into `<home>/skills`, and `/api/playbooks` becomes an
alias over the skill registry — all behind one flag, `STATION_SKILLS_MERGE`
(or `STATION_FEATURES=skills-merge`), **default off this release**.

- **The migration is a one-way write on the user's own data, so it never
  deletes.** `<home>/prompts` is RENAMED to `prompts.migrated-<timestamp>/`
  after the pass succeeds. Rolling back is a rename in the other direction plus
  removing the skills it wrote.
- **Every migrated playbook becomes `command.enabled: true`.** That is not a
  default we liked; being runnable as a `/command` is the only behaviour a
  playbook ever had.
- **Identity survives through `legacyIds`.** Each migrated skill records its
  playbook UUID, and `SkillService.resolveSkillName` is the single place that
  resolves one — so a task's `playbookId`, a bookmarked `/guidance/<uuid>`, an
  MCP script, and the `/api/playbooks/:id` alias all keep working.
- **Plugin prompts are read IN PLACE, not copied.** A plugin's prompt files
  become read-only command skills at every discovery
  (`plugin-command-skill-source.ts`), which removes the copy-into-prompts.json
  lifecycle entirely: uninstall the plugin and its commands are gone, with
  nothing to reconcile.

## The behaviour change to state plainly

**Migrating `agent.prompts` into `agent.skills` ACTIVATES bindings that were
previously inert.**

`agent.prompts` was declared in `schemas/agent.schema.json` and written by the
agent editor's Playbooks picker, and **nothing in the runtime ever read it** —
ticking that box did nothing. `agent.skills` is read
(`runtime-agent-builder.ts`), and reaches a Station-engine agent's skill catalog
and its `activate_skill` tool.

So on the first start with `STATION_SKILLS_MERGE` on, a Station-engine agent
that had playbooks attached in the editor will begin receiving those skills in
its catalog. That is what the user asked for when they attached them, and it is
why we migrate rather than dropping the field silently — but it is a behaviour
change on upgrade, not a no-op. Playbook UUIDs that match no playbook are
logged and dropped, and the whole set of adds/drops is written into the
migration marker (`prompts.migrated-*/.migrated.json`) so it can be read after
the fact.

Two smaller user-visible effects:

- **Names are slugified and duplicates are suffixed.** "Release Check (v2)"
  becomes the skill `release-check-v2`; two playbooks that slug the same get
  `-2`, `-3`. The suffixed one answers to a different `/command` word than it
  did. This is the only lossy step in the merge, and every rename is recorded
  in the migration report.
- **A playbook with no description gets its own name as one.** `description` is
  required by the skill format — a package without one is refused by the parser
  discovery uses — and playbook descriptions were optional. The name is a
  placeholder the author can replace, not a claim about the skill.

## Alternatives considered

- **Drop `agent.prompts` silently.** Loses the user's expressed intent and hides
  the upgrade. Rejected.
- **Copy plugin prompts into `<home>/skills`.** Recreates today's stale-copy
  lifecycle (`removePluginPrompts` matching on a `source` string) with a second
  copy to keep in sync. Rejected — see `plugin-command-skill-source.ts`.
- **Migrate without a flag.** Storage, agent records, the slash resolver, MCP
  tools, the CLI and the e2e lanes all move. One flag for one release means a
  home can be rolled back by renaming `prompts.migrated-*/` back.

## Consequences

- With the flag OFF, everything here is inert: no migration runs, no plugin
  scan happens, `/api/playbooks` is byte-identical to today's `PromptService`
  behaviour, and `agent.prompts` stays in the agent schema and on disk.
- With the flag ON, `POST /api/playbooks/:id/convert-to-skill` and
  `POST /api/skills/:name/convert-to-playbook` answer **410** — there is
  nothing to convert between — and `GET /api/playbooks/providers` answers 410
  (no provider was ever registered on it).
- **`agent.prompts` is translated on every agent save while the flag is on**, not
  only by the boot migration: the agent editor still writes it, and an
  attachment made after the migration archived `prompts/` would otherwise land
  in a field the runtime never reads with nothing left to convert it. An id no
  skill claims is refused with a 400 naming it.
- **Flag-on `/api/playbooks` writes answer 202 with `configurationActivation`**
  when runtime activation defers, exactly as `/api/agents` does. They run
  through the same serialized configuration-mutation runner, because a binding
  written any other way lands on disk and never reaches the running agent — the
  config watcher classifies Station's own write as an internal echo. Every
  binding change goes through one locked read-derive-write updater
  (`mutateAgentConfig`); nothing writes an agent record whole from a snapshot it
  read earlier.
- `schemas/agent.schema.json` keeps `prompts` in this slice, marked deprecated.
  Removing it now would fail validation on every home that has not migrated —
  which, with the flag off by default, is all of them. It is removed in slice 4,
  after the flag defaults on.
- Listing `/api/playbooks` with the merge on reads each command skill's body,
  which the canonical `GET /api/skills` deliberately does not. That cost is one
  more reason the alias is scoped to a single release.
