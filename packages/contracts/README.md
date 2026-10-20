# @kontourai/station-contracts

This package owns cross-package domain shapes used by Station's server, SDK,
CLI and extensions. Import the owning domain subpath rather than an application
internal or a compatibility re-export.

The current surface includes types, constants and executable pure contract
helpers: for example, [child-work reducers](./src/child-work.ts),
[live-surface parsers](./src/live-surface.ts) and
[Task Basis page builders](./src/task-basis-mcp.ts). It is not a service or
transport implementation. Parsing a shape or slicing an already-authorized
collection does not grant access or establish that an operation occurred.

## Installation

```bash
npm install @kontourai/station-contracts
```

Declare it directly when your package imports its subpaths, even if the SDK or
shared package also depends on it. Use a release containing the required export;
this checkout's source is not evidence that a particular npm version is live.

## Source distribution

The [export map and file list](./package.json) expose `.ts` source under `src/`;
they do not select a compiled `dist/` package. Type-only imports can be erased
by the consumer; runtime constants and parsers need a toolchain that handles
the source and its imports. Station's esbuild plugin build is one such consumer.
Do not treat the source suffix alone as proof of compatibility with every
Node loader, bundler or alternate runtime.

## Usage

```ts
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { DEFAULT_GUARDRAILS } from '@kontourai/station-contracts/agent';
```

The root export re-exports a compatibility selection. The subpaths listed in
`package.json` are the authoritative domain inventory; the root does not imply
that every opt-in contract is re-exported. See the
[contracts reference](../../docs/reference/contracts.md) for ownership and
domain descriptions.

For the plugin walkthrough these contracts describe, see the
[`@kontourai/station-sdk`](../sdk/README.md)
README.

## Subpaths without a reference section

The [contracts reference](../../docs/reference/contracts.md) documents most
domains. These subpaths are exported but not described there yet; each line
names what the module owns. Read the module before depending on it.

**Agents, skills and models**

- `/agent-validation`: which runtimes need an authored agent prompt, and engine validation findings.
- `/enriched-agent`: the enriched Agent catalog projection and its capability list.
- `/managed-model-binding`: the one rule for which model connection the managed engine binds.
- `/openai-compat-catalog-semantics`: which OpenAI-compatible hosts enumerate their models, and what an empty list means.
- `/skill-command`: the command word a skill answers to, and its naming rule and refusals.
- `/skill-markdown`: the single `SKILL.md` serializer shared by server and UI.
- `/skill-variables`: the `{{placeholder}}` variables a skill body substitutes.
- `/guidance-assets`: guidance asset conversion from a skill, usage stats and quality score.
- `/portability`: credential-free shapes for guidance and MCP configuration export and import.

**Conversations, turns and outputs**

- `/conversation-context-boundary`: transcript-only projection of an applied context boundary.
- `/turn-provenance-context`: the context sources recorded as a turn's provenance.
- `/turn-changed-files`: the files a turn changed, and why that list can be unavailable.
- `/session-output-declaration`: durable provenance for an output a native tool declared.
- `/session-outputs`: the metadata-only Session Outputs page and inspection (v1).
- `/mcp-elicitation`: the field subset Station renders for an MCP form elicitation.
- `/mcp-app-display-mode`: host-mediated display-mode decisions for MCP Apps.
- `/stall-watchdog`: a stream read raced against a resetting stall timeout.

**Basis, evidence and review**

- `/task-basis`: the exact answer binding and the Task Basis collection.
- `/answer-narrative-binding`: publication and read target for an answer's retained execution narrative.
- `/session-inventory-mcp`: the bounded Session inventory envelopes served over MCP.
- `/review-evidence`: reviewer-authored evidence for a later decision; never a pass/fail verdict.
- `/proposed-change`: proposed file changes, their decisions and snapshots.
- `/diff-comment`: review comments anchored to a line of a file diff.

**Tasks, work and Flow**

- `/project-task-room-browser`: the browser-facing Task room record, link and live-source shapes.
- `/workflow`: Flow Agents workflow sidecar task, phase and next-action shapes.
- `/runs`: run summaries across sources, including direct provider invocations.
- `/starter-work`: the public projection and binding of a registered starter.
- `/work-reference`: correlation-only identities for work owned elsewhere.
- `/work-item-provider`: the provider-neutral work-item listing seam.
- `/pull-request-provider`: provider-neutral pull request capabilities and merge methods.
- `/conversation-pull-request-links`: pull requests linked to a conversation and how each link was found.
- `/action-operation`: the durable execution-status envelope around an existing mutation.
- `/operational-event`: versioned, bounded facts emitted by Station actors; contract only.
- `/live-activity`: the Activity live-collaborator roster projection.
- `/board`: the persisted shape of a board face.

**Workspace Panes**

- `/workspace-composition`: the composition spec a pane host lays out.
- `/workspace-pane-availability`: the user-visible availability decision for one pane.
- `/workspace-pane-builtin-renderers`: the built-in renderer names this build registers.
- `/workspace-pane-layout-adapter`: stable compatibility facade for pane layout adaptation.
- `/workspace-pane-operational-event`: the Station-owned pane lifecycle event envelope.
- `/workspace-file-preview`: bounded file preview limits and results.
- `/workspace-task-room-composition`: Task room composition and its degradations.
- `/workspace-coding-file-composition`, `/workspace-coding-diff-composition`,
  `/workspace-coding-evidence-composition`: coding pane selection and read grants.
- Built-in pane descriptors and instances: `/workspace-activity-pane`,
  `/workspace-agents-pane`, `/workspace-chat-pane`, `/workspace-coding-panels`,
  `/workspace-device-pane`, `/workspace-evidence-panels`, `/workspace-home-pane`,
  `/workspace-layout-pane`, `/workspace-plugin-draft-pane`,
  `/workspace-pull-request-pane`, `/workspace-spatial-board`,
  `/workspace-task-room`.

**Channels, identity and access**

- `/channel-identity`: member and device key identity and agent authorization; shapes and total functions only.
- `/channel-assurance`: the derived worth of a channel record's authorship.
- `/answer-share-channel`: validation and digest input for an answer share's channel binding.
- `/client-origin`: bounded provenance for one user-issued request.
- `/discord`: the remote-chat authorization contract for Discord.
- `/personal-tokens`: personal access token scopes and limits.
- `/plugin-visibility`: the operator's view of per-principal plugin visibility.
- `/user-profile`: the first-run role and comfort answers.
- `/presence`: which of a person's surfaces is focused right now.

**Devices, connections and plugins**

- `/device-toolchain`: the managed device toolchain's derived install and hub state.
- `/device-tools`: Device pane tool actions with values read back from the device.
- `/connection-recovery`: the non-secret connection-recovery contract.
- `/contribution`: the scoped contribution projection, (Station, scope) to named resources.
- `/git-remote-identity`: pure git remote canonicalization.
- `/plugin-draft`: plugin draft preview state, leases and diagnostics.
- `/registry-lifecycle`: registry item lifecycle states.
- `/surface-deep-link`: the `/?surface=` deep link and its query keys.
- `/time`: milliseconds per time unit.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
