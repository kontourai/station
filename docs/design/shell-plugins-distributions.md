# Shell kernel, plugin contributions and distribution manifests

> **Reading status: accepted direction, not built; tracked by
> [#2993](https://github.com/kontourai/station/issues/2993).** This record holds the
> owner decisions of 2026-09-29 and 2026-10-20 and the delivery plan that
> implements them. Nothing below is shipped behavior unless the text says it
> **exists** and cites the source that establishes it. The "Current state"
> section was checked by source inspection against `origin/main` at
> `2e8ddc0f7` on 2026-09-29 and has not been re-checked since. The
> [Coding capability map](#coding-capability-map-condensed) was checked by
> source inspection at `e880e9c92` on 2026-10-20. No test was executed for
> this record. The Sigstore claims under
> [OPEN-4's resolution](#decision-1-open-4-signing-is-sigstore-keyless) are
> reasoned from Sigstore's published bundle format, not from a verification
> Station has run. For current plugin installation and grants, read
> [plugins](../guides/plugins.md) and the
> [installation lifecycle](plugin-installation-lifecycle.md).

Status: **accepted direction** (owner decisions, 2026-09-29 and
2026-10-20). This record amends three earlier records without rewriting them:

- [pane-or-shell.md](pane-or-shell.md), where the runtime tiers become a
  per-install trust grant;
- [plugin-authority-model.md](plugin-authority-model.md), where open
  question 2 is answered and updates re-prompt;
- [shell-ownership-and-boards.md](shell-ownership-and-boards.md), where
  Layouts gain a subject, clone, templates, and a project policy.

Each of those carries a dated cross-reference to this record.

## Three things called "distribution"

The word already has two meanings in this repository. This record adds a
third and always writes it with its qualifier.

| Term | Meaning | State |
| --- | --- | --- |
| Release distribution | How Station binaries and hosts reach users: trains, channels as signed pointers, the installer ([ADR 0020](../adr/0020-distribution-two-trains-channels-as-pointers.md)) | accepted, being implemented |
| **Distribution profile** | Layout-catalog policy in app configuration: which catalog entries are visible, preinstalled and enabled ([guide](../guides/distribution-profiles.md), [`DistributionProfile`](../../packages/contracts/src/distribution.ts)) | exists |
| **Distribution manifest** | A plugin package that names plugins with pinned versions and keys, and sets defaults, setup, branding and policy for a Station (this record) | designed, not built |

A distribution manifest is a superset of a distribution profile. The
manifest's layout-catalog section produces a `DistributionProfile`, so the
existing profile service stays the single owner of catalog projection. Never
shorten "distribution manifest" to "distribution" in code, UI or docs.

## Owner decisions (2026-09-29)

These decisions were made by the owner on 2026-09-29. They are recorded as
given; the engineering reading that follows them says where it adds rules.

1. **Station is a shell that makes itself extensible.** Nearly everything a
   user works in is a plugin contribution: Home (station-level), project
   layouts such as Coding (installed on a project by an admin or operator),
   Inbox/Chat, Board, Browser, Device, PR review, Files. A plugin may
   contribute one thing or many: panes, layouts, a Home, commands, agents, MCP
   tools, server routes.
2. **The shell kernel is only:**
   - the plugin host and installer;
   - trust and permission grants;
   - sign-in, pairing and connection recovery;
   - Settings plus the plugin manager;
   - the server-side authority over agent actions and approvals;
   - **safe mode**.

   If installed plugins leave no Home or working layout, Station boots into
   the shell with the plugin manager. No built-in layout is special.
3. **First-party versus third-party is not the boundary.** Trust is a
   per-install grant made by the operator. Signature provenance informs it:
   Kontour-signed, publisher-signed, or unsigned.
   - Kontour-signed starts trusted in-process (tier 2).
   - Unsigned starts sandboxed (tier 3).
   - The operator may lower either, or raise an unsigned plugin with an
     explicit warning.

   Trust is pinned to publisher key plus content digest. An update signed by
   a different key does not inherit trust, and an update requesting new
   capabilities re-prompts. The CSP-nonce handoff must be fixed before
   "sandboxed" is claimed.
4. **Capability grants are separate from runtime tier.** The manifest requests
   them and the operator approves them at install. High-risk grants require a
   trusted install, for example rendering approval prompts or acting as a
   layout's primary chat renderer. The Kontour chat/inbox plugin holds them
   because the operator trusted it, not because it is core code.
5. **Shared Stations.** The operator decides what is installed and its trust.
   A member can hide or disable a plugin for their own session, but cannot
   enable what the operator has not. Trust prompts state who is affected: all
   members and paired devices.
6. **Layouts become owner × subject.** The owner is project, principal or
   instance (the existing `LayoutOwner`). The subject is a project or none.
   - A project layout is project/project.
   - A personal Board is principal/none, which exists.
   - New: a personal layout for a project ("bring your own lens"),
     principal/project, invisible to other members.
   - New: a personal template, principal/unbound, which binds when it is
     opened on a project.

   Rules:
   - No new access: only panes the principal can see (per D2), and panes run
     with the principal's own project access.
   - Project policy decides whether members may attach personal layouts. The
     default is the project's own panes only; outside plugins need the project
     admin to allow them.
   - Promotion is the sharing path, as it already is for Boards.
   - Add clone: project layout to personal copy.
7. **Layout contract fields** that any layout may declare:
   - `primary: 'chat' | none`. The layout claims the centre for chat, the
     shell suspends the dock's chat and routes ⌘D. This generalizes what the
     in-progress Coding-chat work hard-codes for the built-in Coding layout.
   - `presentation: 'stack' | 'tabs'`. `stack` is the Chat → drill-in
     navigation stack with a breadcrumb and an icon rail; `tabs` is today's
     tabs.
   - `drillIns: paneId[]`.

   The shell's `type === 'coding'` special case is deleted once Coding ships
   as a plugin.
8. **Distribution manifests.** A declarative manifest that is itself a plugin
   package. It names:
   - plugins, with pinned versions and required keys;
   - defaults: the Home layout, project layout templates and default panes;
   - setup: onboarding steps, and the offered sign-in providers with their
     configuration;
   - branding, built on #2902's theming;
   - policy: trust defaults, personal-layout policy and similar.

   A manifest may extend another (inherit, then override) or replace it.
   Precedence is: the operator's local choices, then the distribution
   manifest, then plugin defaults. The shell supports installing one at first
   run or later, as code, and supports "reset to distribution defaults". A
   manifest may choose and configure sign-in. Credential verification,
   sessions and access recovery stay in the kernel, and safe mode is always
   reachable.
9. **A public repository, `kontourai/station-plugins`, for dogfooding.** It
   holds:
   - `plugins/`, one package each;
   - `distributions/kontour-default`;
   - an `acme-distribution` example (in that repository's examples folder), which extends the default, swaps the
     Coding layout and Home, and sets branding and SSO;
   - `templates/plugin-starter`.

   Station's CI runs against pinned released versions of the bundled plugins.
   Migration order, by risk: Board first (`packages/board-pane` is already
   extracted but compiled in), then Browser/Device panes, then Coding, then
   Home, and Inbox/Chat last.
10. **Branding and "all the things" (owner addition, same day).** A
    distribution manifest can carry branding and the defaults enumerated in
    [what a distribution manifest may set](#what-a-distribution-manifest-may-set),
    within the three limits recorded there: kernel surfaces cannot be spoofed,
    native binary identity is build-time, and brand rules still apply.
11. **Required slots (owner clarification, same day).** The concept of Home
    always exists, and "no Home" stays inexpressible (the invariant in
    [`workspace-home-role.ts`](../../packages/contracts/src/workspace-home-role.ts)).
    - Home is a required kernel **slot**. Kontour's default Home plugin fills
      it.
    - A distribution manifest or the operator may override (replace) the
      filler, never remove it.
    - If the overriding Home fails to load, is disabled, or is uninstalled,
      the slot falls back to the default filler. That filler therefore ships
      with the shell's default set and cannot be uninstalled, only overridden.
    - Other required slots, such as the primary chat and approval surface,
      follow the same rule.
    - Safe mode remains the floor for the broader "plugins are broken" case.
      Home does not wait on it.

**Reading note (this record).** Decision 11 supersedes the Home half of
decision 2. Decision 2 says Station boots into safe mode "if installed
plugins leave no Home"; under decision 11 that state cannot occur, because
"no Home" is inexpressible and the default filler always resolves. Safe mode
still covers the rest of decision 2: no working layout, or a default filler
that itself fails to load.

## Owner decisions (2026-10-20): Coding as a plugin

The owner's direction is that Station exposes its core functionality through
the SDK and plugin interface, so plugins can extend and build on the core.
Coding is the forcing function: it ships as a plugin from
`kontourai/station-plugins` (slice j). The owner pulled j's whole dependency
chain forward and made four decisions on 2026-10-20. Each is recorded as
given, followed by this record's engineering reading. Where the reading adds
a rule or finds a conflict, it says so.

1. **OPEN-4 signing: Sigstore keyless.** There is no long-lived Kontour
   plugin key. station-plugins' release workflow signs with its GitHub OIDC
   identity through Sigstore. Station pins the expected workflow identity
   (repository, workflow path, ref pattern) and verifies the bundle,
   including the transparency-log inclusion proof.
2. **Everything in Coding moves into the plugin.** That includes the diff,
   file preview, terminal pane UI, PR review and the plan/readiness/trust
   composition, not only the Coding-only panes. (File preview and PR review
   were later given their own plugins; see the OPEN-13 answer below.) Core keeps the capabilities:
   data queries, the terminal session store and view in the SDK (per
   [terminal.md](terminal.md)), permissions and server routes. Other core
   surfaces that use these panes today consume them by pane descriptor
   through the plugin, or use SDK view components. Pane descriptor ids and
   stateKeys are kept so saved layouts keep working; only provenance
   changes.
3. **Pinning: `plugins.lock`.** Station commits a lock naming each plugin's
   name, version, artifact URL, sha256 and Sigstore identity. CI installs the
   released artifacts, verifies them, and fails if one is missing. A bot PR
   bumps the lock. The same lock defines the offline bundled default set,
   installed at first run with no network (slice i0). station-plugins' CI
   tests against Station's published preview build.
4. **UI kit: upstream to `@kontourai/ui`.** Tabs, IconButton, an overflow
   menu, relative time and the glyph set are added to the public
   `@kontourai/ui` package. Station adopts them, and `@kontourai/ui/react`
   joins `SHARED_EXTERNALS`. Behavioural dialogs become host capabilities
   (`host.confirm` exists; add `host.prompt` and `host.menu`). The
   `@kontourai/station-components` virtual module is deprecated.

The same day the owner also adopted OPEN-5's proposal (a project-scoped
"manage layouts" permission) and the research recommendations recorded in
the delivery plan: j is **[security]**, j's acme acceptance moves to a
fixture replacement layout, and a growth-only import ratchet guards
`coding-layout/` while #3039 work continues.

**Owner answers to the open items (2026-10-20).** Later the same day the
owner answered three items this record had left open:

- **OPEN-14: pre-approved by lock.** Each `plugins.lock` entry lists the
  plugin's capabilities. A `kontour`-provenance plugin listed in the lock
  gets exactly those capabilities with no prompt.
  - *Engineering reading, for owner confirmation:* anything beyond the
    listed capabilities prompts.
  - *Engineering reading, for owner confirmation (the coordinator's
    implementation of the answer):* capabilities in the high-risk class
    (for example `approvals.render`, `agents.invoke`) are **excluded** from
    lock pre-approval. Even when listed, they are decided on the consent
    listener, as d3 requires for every high-risk grant. See
    [the bundled-set exception](#trust-and-grants) under
    Trust and grants.
- **OPEN-12: "wait for Ghostty".** In the owner's words, j waits for
  Ghostty: there is no interim. This record maps that to the SDK
  `TerminalView`, which [terminal.md](terminal.md) builds on its Ghostty
  adapter in phases 2 to 4 (slice SDK-5); j ships only once it exists. The Coding plugin renders `TerminalView` or
  opens the core closed terminal target.
- **OPEN-13: their own default plugins.** File preview and PR review each
  ship as their own plugin in the bundled default set (slices jF and jP).
  Chat and Coding both use them, and nothing outside Coding depends on the
  Coding plugin.

### Decision 1: OPEN-4 signing is Sigstore keyless

**What Station pins.** For each Kontour plugin, the expected signer is an
identity, not a key:

- the OIDC issuer, GitHub Actions' token issuer;
- the certificate's workflow identity: repository
  `kontourai/station-plugins`, the release workflow's path, and a ref
  pattern for release tags;
- the certificate's numeric repository and owner identifiers, so a deleted
  and re-created repository of the same name does not inherit trust;
- the trigger event and a GitHub-hosted runner, so a `workflow_dispatch` or
  self-hosted run of the same workflow does not match.

The owner named repository, workflow path and ref pattern; this record adds
the numeric identifiers, trigger event and runner, which Fulcio certificates
for GitHub Actions also carry.

Station verifies the Sigstore bundle against Sigstore's trusted root: the
Fulcio certificate chain, the signature over the artifact digest, and the
Rekor entry's inclusion proof against its signed checkpoint. A bundle without
a transparency-log entry and inclusion proof is refused.

**Signing time.** The Fulcio certificate lives about ten minutes, so the
verifier's clock cannot judge it. The bundle must carry **at least one
verified timestamp**, and the certificate's validity window must contain it:

- a Rekor v1 entry's signed entry timestamp (its inclusion promise over
  `integratedTime`), verified with the log key; or
- an RFC 3161 timestamp from a timestamp authority in the trusted root.

Rekor v2 entries carry no `integratedTime`, so a bundle whose only log entry
is a v2 entry needs the RFC 3161 timestamp. The inclusion proof alone proves
that an entry exists, not when it was signed.

**d1 (trust records).** The install trust record pins a **signer plus
digest** instead of a key plus digest:

```text
signer: { kind: 'sigstore', issuer, identity, repositoryId, ownerId }
      | { kind: 'ed25519', keyId }      // registry-trust-policy keys, unchanged
      | null                            // unsigned
```

- `provenance: kontour` means the bundle verified, its identity matched the
  identity Station pins, **and** the plugin's name has a `plugins.lock`
  entry (see below). Any other valid Sigstore bundle is `publisher`.
- The owner's 2026-09-29 rule "an update signed by a different key does not
  inherit trust" reads, for Sigstore, as "an update whose verified identity
  differs". The rest of the pinning rules stand.
- d1 adds a Sigstore verifier with an embedded trusted root to `src-server`.
  That is a new dependency on the installer path and part of d1's security
  review.

**Offline verification.** Keyless verification can run with no network, under
three conditions:

- Station embeds a `trusted_root.json` (Fulcio certificates and Rekor,
  certificate-transparency and timestamp-authority keys), snapshotted at
  release build time: the build fetches it from Sigstore's TUF repository
  and verifies it there. At runtime Station loads that file directly; it runs
  no TUF client.
- Each bundled plugin carries its Sigstore bundle, and that bundle includes
  the inclusion proof and signed checkpoint plus at least one verified
  timestamp as above.
- The verifier is configured with the embedded root and makes no TUF or
  Rekor request.

Every bundled artifact was signed before the Station release that ships it,
so that release's embedded root always covers it. What offline verification
**cannot** do:

- refresh Sigstore's own root, which therefore moves only with a Station
  release;
- check log consistency (detect a split view by a compromised log), which
  needs an online read;
- learn of a revocation published after the installed release.

The honest consequence for i0 is that the stronger anchor for the bundled
set is the sha256 in `plugins.lock`. It reaches the user inside the Station
release, whose integrity is that release channel's own (for desktop, ADR
0020's signed updater). The offline Sigstore check adds two things: it
confirms which workflow built the bytes, and it gives a bundled plugin the
same `kontour` provenance a downloaded install gets. i0 therefore needs no
"bundled" exception in the trust rules. **Conclusion: Sigstore keyless works
for the offline first-run install, with these stated limits.**

**Rotation.** There is no key to rotate. A change of signer identity (a
renamed repository, a moved workflow file, a new ref pattern) ships as a
Station release that pins both the old and the new identity for an overlap
window, then drops the old one. Sigstore's own root rotation reaches online
Stations through the embedded root of each release.

**Revocation** (*engineering reading, for owner confirmation*: the owner
named a denylist; shipping it inside each release is this record's
proposal). Each Station release ships a denylist of digests (one bad
release) and of identities or identity-plus-time windows (a compromised
workflow period). The installer refuses a denylisted digest or identity at
install and on every activation. An offline Station learns of a revocation
only when it updates.

**What keyless moves, not removes.** Whoever can make station-plugins' release
workflow run on a matching ref can sign as that identity. Station can check
only what the certificate states: repository, workflow path, ref, trigger
and runner. It cannot see that a release environment required reviewers. So
the workflow's own protections are part of i1's acceptance: a tag ruleset on
release tags, a release environment with required reviewers, only the
signing job holding `id-token: write`, and no `pull_request_target` path to
that job.

**Which plugins are `kontour`.** The same workflow may also release
examples, the starter template and the acme distribution. `kontour`
provenance therefore requires **both** the pinned identity **and** a
`plugins.lock` entry for the plugin's name, read from the verified
artifact's manifest. An artifact from the pinned workflow whose name is not
in the lock is `publisher`. This record picks this over restricting the
workflow to locked plugins because:

- station-plugins cannot see Station's lock, so a workflow-side restriction
  would be a second list to keep in step;
- it still holds if the workflow is later broadened by mistake;
- a newer version of a locked plugin, released independently, stays
  `kontour` (the lock pins the name for provenance; the sha256 pins only the
  bundled version).

Provenance is **recomputed** against the running release's lock on every
start, not recorded once at install. Recomputing means re-checking lock
membership of the plugin's name against the verified signer identity stored
in its d1 record at install; it does not re-verify signatures. A plugin that a later release drops
from the lock therefore loses `kontour` provenance; i0 states what follows.
The global pinned identity, compiled into Station, decides provenance. Each
lock entry still carries its Sigstore identity (decision 3 names it), but
that field must equal the pinned identity: CI and the release build refuse
a lock whose entry names any other identity, so the field documents the
entry and cannot widen trust.

Keeping examples in a separate workflow file is still good hygiene, as
defence in depth.

**Third-party publishers.** A publisher who signs keylessly from their own CI
gets `publisher` provenance with the verified identity shown at install, for
example a repository and workflow. Station pins that identity on first trust
(trust on first use) plus the digest, and an update from a different
identity is a new decision. A verified identity proves which repository's
workflow built the bytes, not that the publisher is vetted, so OPEN-3's
proposed tier-3 default for publisher-signed plugins still matters. Registry
ed25519 keys under [registry-trust-policy.md](registry-trust-policy.md)
remain a second signer kind.

**What stays open after OPEN-4** (see [OPEN-4](#open-items)):

- a revocation feed between releases, and what signs it;
- whether online Stations refresh Sigstore's root through TUF or use only
  the embedded root (proposed: embedded only, refreshed per release). The
  cost of "embedded only": a Station older than a Sigstore key rotation
  cannot verify plugins signed after it, and must update before installing
  them;
- whether online installs also query Rekor for consistency (proposed: no);
- the operator UX for reading and pinning a third-party identity;
- support for issuers other than GitHub Actions, and for a private Sigstore
  deployment.

ADR 0020's updater keys are unaffected. They sign Station binaries, a
different artifact on a different path.

### Decision 2: everything in Coding moves into the plugin

Core keeps capabilities; plugins own the panes. This replaces the research
recommendation that diff, file preview, terminal and PR review stay core
panes the plugin references. Under the OPEN-13 answer, file preview and PR
review are not Coding panes at all: each is its own plugin in the bundled
set (jF, jP), which chat and Coding both open by descriptor.

**This record's reading of "plan/readiness/trust composition"** (*engineering
reading, for owner confirmation*). The Coding inspector's arrangement of
those three panes moves. The panes themselves
(`workspace-plan`, `workspace-readiness`, `workspace-trust`) stay core:
the server lists them as general pane declarations any layout may place
([workspace-pane-known-declarations.ts](../../src-server/services/projects/workspace-pane-known-declarations.ts)).
Today their content components live in
`coding-layout/CodingInspectorPanel.tsx`; slice SDK-views moves them, with
`planSession`, to their core domains (`flow/`, `readiness/`, `trust/`).

**Pane ids.** The descriptor ids are `pane:builtin:coding:file-browser`,
`pane:builtin:coding:diff` and `pane:builtin:coding:terminal`
([workspace-coding-panels.ts](../../packages/contracts/src/workspace-coding-panels.ts)).
The `workspace-coding-*` strings, including `workspace-coding-terminal`, are
their instance ids, stateKeys and renderer names. Both are kept. The
terminal pair is different; see **Terminal** below. A plugin's
layout panes normally get a minted id of the form `pane:plugin%3A<plugin>:…`
(see `layout-pane-reference.ts`), so keeping the `pane:builtin:coding:*` ids
needs an explicit **legacy-id adoption** rule. The rule is security-relevant,
because any plugin that could claim a `pane:builtin:*` id could stand in for
a core pane. It belongs to slice jG: a fixed table maps each legacy id to the plugin that
owns it, honoured only when that plugin has `kontour` provenance (pinned
identity and a lock entry):

| Legacy id | Owning plugin |
| --- | --- |
| `pane:builtin:coding:file-browser`, `pane:builtin:coding:diff` | Coding (j) |
| `pane:builtin:workspace-preview:file-preview` and the `file-preview:` instance family | File preview (jF) |
| `pane:builtin:workspace-pull-request` and the `pr:` instance family | PR review (jP) |

The terminal ids are not adopted.

**Core sites that use Coding panes today, and the recommendation for each**
(verified at `e880e9c92`):

| Site | Uses today | Recommendation | With the Coding plugin absent |
| --- | --- | --- | --- |
| `views/TaskWorkspaceView.tsx:31-32` | `DiffPanel`, `FileContentViewer` inline in a task | **SDK view components** (`DiffView`, `FileView`). A task embeds content, not panes | No change: Tasks keeps its diff and file views |
| `workspace-panes/FilePreviewPane.tsx` (its diff mode lazily imports `DiffPanel` at :1023) | The file-preview pane itself | Moves into the file-preview plugin (jF); its diff mode uses SDK `DiffView` | Unaffected: file preview is its own plugin |
| Callers that open file preview: chat dock and its view model, `SessionsView`, navigation store and `useOpenInRegion`, the region `file-preview:` family | Open a file link in the preview pane | **By descriptor** through the pane-open capability (SDK-4). #3875 reworks file-preview relations, so jF coordinates with that lane | Unaffected. Only without the file-preview plugin does the open answer `unavailable`, and file links then show the path with a copy action |
| `workspace-panes/builtinWorkspacePaneRegistry.tsx:75-83, 756` | Registers the Coding panes, the evidence-pane content, `selectWorkflowPlanSession`, and the lazy PR review panel | Drop the file-browser and diff registrations (Coding plugin, j) and the PR review registration (PR review plugin, jP). The `CodingTerminalPane` registration is retired when j lands; the terminal is the core closed target (SDK-5). SDK-views moves the evidence-pane content and `planSession` to core | Plan, readiness and trust panes keep working. Coding panes in saved layouts render `unavailable` with a reason |
| Region `pr:` family and the dock's PR chips (`region-surface-panes.ts:321`, `region-model.ts`) | Open PR review from chat | **By descriptor** (SDK-4), to the PR review plugin (jP) | Unaffected. Only without the PR review plugin do PR chips open the pull request externally (`host.openExternal`) |
| Region `coding:diff`, `coding:file-browser` families (`region-surface-panes.ts:307-309`) | Dock placements of Coding panes | By descriptor; the architecture ratchet's source map points at the plugin | Those dock placements render `unavailable` with a reason |
| Region `coding:terminal` family (`region-surface-panes.ts:305-306`) | Dock placement of the terminal | The core terminal target (`pane:builtin:coding:terminal` stays its presentation alias) | Unaffected: the terminal is core |
| `components/modals/NewChatModal.tsx:82` | Helpers from `coding-layout/chatContextDraft.ts` that compose a start message (not a pane) | SDK-3 moves the helpers into core chat start; the plugin supplies its context draft through SDK-3 | New chat works. A Coding context draft is offered only when the plugin supplies one |
| `app-shell/ProjectLayoutRenderer.tsx:60-68` | `CodingWorkbench`, `codingPanels`, `codingStackPage` | Slice a's generic host and a2's generic panel record | No Coding layout in the catalog; a stored Coding layout renders `unavailable` with a reason and offers reinstall from the bundled set |

**Consequence, stated plainly.** Because i0 installs Coding by default, the
plugin is absent only when an operator uninstalls or disables it, or a
distribution manifest leaves it out. Then: no Coding layout; stored Coding
layouts and docked Coding file-browser and diff panes show `unavailable`;
the "Open in Coding" entries disappear. Chat and Sessions file links, PR
review, Tasks, the evidence panes and the terminal are unaffected, because
none of them depends on the Coding plugin.

**File preview and PR review (OPEN-13, answered 2026-10-20).** This record
had pushed back that both are the general targets for links in chat, not
only Coding panes. The owner answered by making each its own plugin in the
bundled default set (jF, jP).

**Terminal** (*engineering reading, for owner confirmation*). The decision
says "terminal pane UI" moves. This record reads that as **presentation
only**: the terminal stays a core closed target. That reconciles decision 2
with [terminal.md](terminal.md) and its amendment in #3894 (open at the time
of writing). The terminal is a core feature and a **closed built-in pane
target**, `{ kind: 'terminal'; binding; terminalId?; new?: { profile? } }`,
declared in the pane host contract. `pane:builtin:coding:terminal` and
`workspace-coding-terminal` become presentation aliases that resolve to the
binding's terminal group. What the plugin owns is how the terminal appears
inside Coding (the drawer's place and size, per #3875's presentation
seams). The terminal UI it shows comes from one of two places:

- it opens the core terminal target through SDK-4; or
- it renders the SDK `TerminalView` over the SDK session store.

Either way the caller's **own** `terminal:operate` or `terminal:observe`
grant for the project decides, as terminal.md specifies: creating a terminal
needs `terminal:operate`; opening an existing one needs `terminal:observe`
and is read-only without `terminal:operate`. A pane or plugin grant never
implies terminal access. So jG adopts no terminal id and adds no
install-time terminal grant.

Under the OPEN-12 answer there is no interim: j waits for `TerminalView`
(SDK-5). When j lands, the existing `CodingTerminalPane` (and the
`coding-layout/` terminal components behind it) is retired. Two items that
#3894 assigns to "the Coding layout" become plugin-side work after j: its
boundary test that Coding imports no terminal internals (it then scans the
Coding plugin in station-plugins), and the one-time import of the
`coding-terminal-*` presentation state (open, height) by Coding's panel
writer.

### Decision 3: `plugins.lock` and the offline default set

- **The lock.** A committed JSON file. Each entry holds name, version,
  artifact URL, sha256, the Sigstore identity from decision 1 (which must
  equal the pinned identity), and the plugin's capabilities (the OPEN-14
  answer). Entries are sorted by name, so two bumps touching different
  plugins merge cleanly.
- **The lock is a trust root.** It decides which plugins are `kontour`, and
  which capabilities they get with no prompt, so a change to it must be
  reviewed by people Station trusts for that. Today nothing requires it:
  `main`'s pull-request rule has `require_code_owner_review: false`, no
  required approvals and `required_reviewers: []` (read from `gh api
  repos/kontourai/station/rules/branches/main` on 2026-10-20). Protecting
  the lock is a repository-settings change, so it is a **prerequisite of i0
  that the owner performs**, not something an i0 pull request can do.

  **Mechanism: GitHub's required reviewer ruleset rule.** It has been
  generally available since 2026-02-17
  ([changelog](https://github.blog/changelog/2026-02-17-required-reviewer-rule-is-now-generally-available/);
  [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).
  It requires a number of approvals from named teams when a pull request
  changes files matching `file_patterns` (`.gitignore` syntax). It is not
  available on user-owned repositories; `kontourai/station` is
  organization-owned. The team must have write permission for its approvals
  to count. The rule would name `plugins.lock` and one reviewing team, with
  one required approval.

  Alternatives considered:
  - Repository-wide `require_code_owner_review` gates every CODEOWNERS path
    (`.github/workflows/`, `.github/CODEOWNERS`, many `scripts/` gates), not
    only the lock.
  - A required check is weaker and more machinery than the native rule.
    Anyone with write access can post a commit status with the same name
    unless the ruleset pins the check to an app by its `integration_id`.
    A `pull_request` workflow runs the pull request's own copy of the
    workflow, so the change it checks can rewrite it;
    `pull_request_target` and `pull_request_review` workflows run from the
    base branch, which avoids that but still needs the app pinning. A check
    is acceptable only as a pinned-app alternative.
  - Push rulesets and their file-path restriction do not apply: GitHub
    offers them for private and internal repositories, and this repository
    is public.

  Costs and limits of the required reviewer rule:
  - **Owner-authored lock changes.** i0, i2, jF, jP and j each add a lock
    entry in a pull request the owner may author, and an author cannot
    approve their own pull request. The reviewing team therefore needs a
    second member, or those pull requests need a ruleset bypass actor (which
    then bypasses this check).
  - **Automation credentials.** Agent sessions act with the owner's
    credentials. If the owner's account is on the reviewing team, an agent
    session can approve a bot's lock bump, and "the review is the review of
    what Kontour code ships" then means "whoever holds that token approved
    it". The reviewing team should contain only accounts whose credentials
    no automation holds. That rules out the owner's own account as it is
    used today, because agent sessions hold its credentials. Every lock
    change, bot bumps included, then needs approval from another human or
    from a separate owner account that agents never hold.
  - **Merge queue.** `main` uses a merge queue. GitHub's documentation for
    the rule does not say how it is evaluated for `merge_group` runs; the
    expectation is that the pull request's approval gates entry to the queue
    and the queue does not re-evaluate it. **To confirm** with a test lock
    change before i0 relies on the rule.
- **CI.** Installs every entry from its released artifact, checks the sha256
  and the Sigstore bundle, and fails when an artifact is missing or
  unverifiable. CI never installs workspace sources of a plugin.
- **Bumps.** A bot PR changes the lock. Once the required reviewer rule
  above is in place, and its team excludes automation credentials, that
  review is the review of what Kontour code ships by default and with which
  capabilities. Until then it is not, and i0 does not start.
- **Cross-repository testing.** station-plugins' CI runs against Station's
  published preview build, so the two repositories never move in lock-step.
- **The offline default set (slice i0).** The Station release carries every
  locked artifact and its Sigstore bundle. At first run, with no network,
  the installer installs the set from that payload and verifies it as in
  decision 1. On every start it installs any locked plugin that is missing
  and not marked uninstalled, so a Station upgraded across j, jF, jP or i2
  gets those plugins without a network. Release size grows by the bundled
  plugins.

**How the `BUILTIN_CODING_LAYOUT` promise survives.** Its docstring calls it
"the safe starter that every Station installation can create without a
registry, plugin, or network dependency"
([layout.ts](../../packages/contracts/src/layout.ts)). After j, Coding *is*
a plugin, so the words "or plugin" become false and must change in j. The
substance holds: no registry and no network, because the Coding plugin is
in the bundled set and installs from the release payload. If an operator
uninstalls it, reinstalling from the same payload is still offline. The
catalog entry stops being `source: 'builtin'` and becomes the bundled
plugin's contribution.

### Decision 4: UI kit upstream

- Tabs, IconButton, an overflow menu, RelativeTime and the glyph set go into
  `@kontourai/ui/react`. That package (1.20.1 on npm and installed at
  `e880e9c92`) has none of them today.
- Station moves its own Button, IconButton, Tabs, Empty and Skeleton onto
  the package, so there is one source. `@kontourai/ui` 1.20.1 has no Tabs or
  ErrorState: KIT adds Tabs upstream, and Station's ErrorState moves only if
  an ErrorState is also added upstream.
  `@kontourai/station-sdk` already imports `@kontourai/ui/react`
  (`packages/sdk/src/components/ErrorState.tsx`).
- `@kontourai/ui/react` joins `SHARED_EXTERNALS` and
  `SHARED_EXTERNALS_REGEX` ([build.ts](../../packages/shared/src/build.ts)),
  the runtime shim that supplies shared modules
  ([pluginSharedRuntime.ts](../../src-ui/src/core/pluginSharedRuntime.ts)),
  and the `station dev` mock (`packages/cli/src/dev/template-scripts.ts`).
  Tier-2 plugins then use the host's exact version, theme and CSS. A plugin declares a peer range;
  a tier-3 frame bundles the package and its token CSS.
- Behavioural dialogs are host capabilities, because they depend on kernel
  chrome and limit 1 requires kernel prompts to stay distinguishable:
  `host.confirm` exists on the pane host contract
  ([workspace-pane-host-contract.ts](../../packages/contracts/src/workspace-pane-host-contract.ts));
  `host.prompt` and `host.menu` are added in SDK-1.
- `@kontourai/station-components` is deprecated. It is a runtime-only
  virtual module exposing only `UserDetailModal`
  ([pluginSharedRuntime.ts](../../src-ui/src/core/pluginSharedRuntime.ts)),
  and the `station dev` mock stubs it to `null`. It stays in
  `SHARED_EXTERNALS` through a deprecation window, because existing plugins
  may import it; the plugin build warns on that import.

## Current state (verified 2026-09-29, source inspection at `2e8ddc0f7`)

What each item below establishes is location and code shape, not executed
behavior.

**Layouts and Boards**

- `LayoutOwner` is `project | principal | instance`, derived only by
  `layoutOwner()` ([layout.ts](../../packages/contracts/src/layout.ts)). A
  Layout has no subject field.
- Boards exist:
  - The Personal Boards `+` creates an "Untitled Board" and enters rename.
    The section and its `+` remain visible when no Board exists
    ([ProjectSidebarBoards.tsx](../../src-ui/src/components/project-sidebar/ProjectSidebarBoards.tsx)).
  - The palette offers "New Board".
  - Rename, delete and promote exist
    ([personal-layouts.ts](../../src-server/routes/me/personal-layouts.ts),
    [service](../../src-server/services/layouts/personal-layout-service.ts)).
  - `PUT /api/me/layouts/:slug` accepts `config`, but the only UI caller of
    the update mutation is rename, so no UI adds panes to a Board.
  - Reorder and clone were not found.
- Instance-owned Layouts have storage
  ([layout-owner-storage.ts](../../src-server/domain/layout-owner-storage.ts)),
  but no route and no UI.
- D2 plugin visibility exists as an operator-granted, per-principal projection
  ([plugin-visibility-service.ts](../../src-server/services/plugins/plugin-visibility-service.ts)).
  Layout pane references fail closed on invisible plugins.
- No per-project plugin or pane policy was found. Project roles exist
  ([project-membership.ts](../../packages/contracts/src/project-membership.ts)):
  `manage-extensions` belongs only to `owner`, and `admin` holds
  `manage-members` but not `manage-extensions`.

**The Coding and Chat special cases**

- `type === 'coding'` is special-cased in:
  - [project-layout-kind.ts](../../src-ui/src/app-shell/project-layout-kind.ts)
  - [ProjectLayoutRenderer.tsx](../../src-ui/src/app-shell/ProjectLayoutRenderer.tsx)
  - [ProjectPage.tsx](../../src-ui/src/views/ProjectPage.tsx)
  - [useChatDockViewModel.ts](../../src-ui/src/components/chat-dock/useChatDockViewModel.ts)
  - [LayoutWorkspacePane.tsx](../../src-ui/src/workspace-panes/LayoutWorkspacePane.tsx)
  - [workspacePaneDirectRoute.ts](../../src-ui/src/workspace-panes/workspacePaneDirectRoute.ts)
  - [builtinWorkspacePaneCanonical.ts](../../src-ui/src/workspace-panes/builtinWorkspacePaneCanonical.ts)

  *2026-10-20:* this list was incomplete. It omitted the sites in
  `packages/contracts` and `src-server`. The complete list is in the
  [Coding capability map](#coding-capability-map-condensed).
- Only a `chat`-kind layout suspends the ambient chat dock (`App.tsx`). ⌘D is
  `dock.toggle` in [region-model.ts](../../src-ui/src/regions/region-model.ts).
- The Coding chat-centre and navigation-stack work lives on the
  `feat/coding-chat-main` branch. It was not yet a pull request, and its diff
  was not reviewed for this record.

**Compiled-in panes and Home**

- `@kontourai/station-board-pane` and `@kontourai/station-basis-pane` are
  `private: true` workspace packages imported directly by `src-ui`.
- Home is a role grant. A plugin pane can be granted the Home role only
  through a consent transaction on the distinct-origin consent listener
  ([plugin-home-role-routes.ts](../../src-server/routes/plugins/plugin-home-role-routes.ts)).
  Uninstall, version change or byte change lapses the grant, and the root
  route falls back to the built-in Home, which "is the un-removable floor"
  ([workspace-home-role.ts](../../packages/contracts/src/workspace-home-role.ts)).
  That contract's docstring still says the grant constructor has "NO
  production caller". The routes above now call it, so the docstring is stale
  (a code-comment fix, outside this docs change).

**Runtime tiers, CSP and grants**

- A pane's runtime is chosen from its declared renderer candidates against
  the host's capabilities: `trusted-plugin-react`, `sandboxed-plugin-frame`
  (offered only when a client flag enables frames) and `sandboxed-mcp-app`
  ([renderer selection](../../src-ui/src/workspace-panes/workspacePaneRendererSelection.ts),
  [contract](../../packages/contracts/src/workspace-pane-renderer-selection.ts)).
  Neither an operator nor a per-install record chooses it.
- CSP: a same-origin plugin bundle loads by URL with no nonce. The
  cross-origin inline path in
  [PluginRegistry.ts](../../src-ui/src/core/PluginRegistry.ts)
  (`executeBundleInline`) still assigns the shell nonce, so it has not been
  eliminated. Frame-hosted plugin panes receive no nonce or credential
  ([PluginFrameHost.tsx](../../src-ui/src/components/plugins/PluginFrameHost.tsx)).
- Grants record the content digest they were given against (`bound`,
  `unverified` or `changed`). A legacy-path update rebinds grants and withdraws
  those tied to replaced bytes
  ([plugin-permissions.ts](../../src-server/services/plugins/plugin-permissions.ts),
  [lifecycle routes](../../src-server/routes/plugins/plugin-lifecycle-routes.ts)).
  Permission derivation still covers fewer contribution kinds than the install
  consent boundary, as recorded in the authority model's reading status.
- Signatures: registry claims may carry ed25519 signatures, verified against
  operator-configured `trustedEd25519Keys` per registry profile
  ([registry-trust-policy.md](registry-trust-policy.md)). `keyId` is a label,
  not a publisher identity. Consuming verified claims in preview and
  activation is open as [#1521](https://github.com/kontourai/station/issues/1521).
- Every plugin bundle's build shim still assigns `globalThis.require`
  ([build.ts](../../packages/shared/src/build.ts)), so in-process plugins
  share one module resolver.
- In-process plugin code runs in the shell's own document. The authority
  model records that it holds the operator's session credential, the shell
  DOM, and the SDK's credentialed client
  ([why enforcement needs a boundary](plugin-authority-model.md#why-enforcement-needs-a-boundary-precisely)).
- A tool approval is decided by `POST /tool-approval/:approvalId` with body
  `{ approved }` ([invoke.ts](../../src-server/routes/agents/invoke.ts)). The
  route is authority-bound. `resolveAuthorized` checks the request's
  authority and client origin against the pending entry
  ([approval-registry.ts](../../src-server/services/approvals/approval-registry.ts)).
  It accepts the decision from any caller holding the requesting session's
  authority, and code running in the shell's document holds it.
- A device-local trust store admits a remote Station's bundles into this
  device's webview: `remotePluginBundlesAllowed`, kept in `localStorage` per
  connection ([remotePluginBundleConsent.ts](../../src-ui/src/core/remotePluginBundleConsent.ts),
  read by [PluginRegistryGate.tsx](../../src-ui/src/components/registry/PluginRegistryGate.tsx)).
  Code already admitted can write that store.

**Branding, sign-in and defaults**

- A plugin `branding` provider supplies app name, logo, theme and welcome
  message ([provider-interfaces.ts](../../src-server/providers/provider-interfaces.ts),
  [`/api/branding`](../../src-server/routes/system/branding.ts)).
- The white-label theme applies five role tokens and refuses the whole theme
  (keeping defaults) on an unknown key, a non-hex value or a failed contrast
  check. Under a named color theme, a slot group that fails on that theme's
  surfaces falls back to the theme's value
  ([decision](../decisions/user-color-themes.md)). Since #2952, which was re-checked after merging it, the check is
  `@kontourai/ui`'s `validateBrandOverride` plus Station's own stricter text
  rules: two on 1.16.0, one (the action fill) since the 1.18.0 bump, whose
  validator took over the brand rule ([branding-theme.ts](../../src-ui/src/lib/branding-theme.ts);
  [theming guide](../guides/theming.md#white-label-branding-theme)).
- Operator-configured sign-in exists: an OIDC configuration file and an
  authentication module
  ([deployment authentication](../guides/deployment-authentication.md)).
- Safe mode does not exist. Only per-plugin recovery exists.
- No documented white-label *build* path exists. Desktop, iOS and Android
  identity is set in build configuration
  ([tauri.conf.json](../../src-desktop/tauri.conf.json)).

## The model

### Kernel and contributions

The kernel is the shell half of [pane-or-shell](pane-or-shell.md#the-rule),
narrowed and made explicit. It contains:

- the plugin host and installer;
- trust and grant records;
- sign-in, pairing and connection recovery;
- Settings and the plugin manager;
- the server-side authority over agent actions and approvals;
- safe mode;
- the **required slots** (below).

Everything a user works in is a contribution from an installed plugin. The
pane-or-shell tests still decide which side a surface sits on. This record
changes where the work surfaces come from: a plugin package, including
Kontour's own, instead of code compiled into `src-ui`.

**Required slots.** A slot is a kernel-owned position that must always have a
filler. Candidates are Home and the primary chat and approval surface.
- The kernel ships a default filler for each slot in the shell's default set.
  It is Kontour-signed, pinned, cannot be uninstalled, and is always
  loadable.
- A distribution manifest or the operator may **override** the filler. A
  filler is never removed.
- When an override fails to load, is disabled, or is uninstalled, the slot
  resolves to the default filler. This is the existing Home-role behavior
  (`lapsed` grants fall back to the built-in Home), generalized. For
  approvals it guarantees that a pending approval always has a renderer the
  kernel trusts.
- Resolution is derived on every read from the live installation, never a
  stored "active filler" label.
- **The operator cannot disable a default filler**, only override it.
  Disabling would be removal by another name. An operator who wants a
  different Home installs an override; a member's personal hide does not
  apply to slot fillers (see OPEN-9).
- **If the default filler itself fails to load**, the slot cannot resolve and
  Station enters safe mode. That is the only path from a slot to safe mode.

### Contribution scopes

| Scope | Who installs or attaches | Examples |
| --- | --- | --- |
| Instance | operator | plugins themselves, Home override, distribution manifest |
| Project | project member holding the new project-scoped "manage layouts" permission: `owner` and `admin` (OPEN-5, adopted 2026-10-20; implemented by `manage-layouts` in slice b) | project layouts such as Coding |
| Principal | the person | Boards, personal project layouts, personal templates |

A member may hide or disable an installed plugin for their own session. That
preference lives in personal scope. It narrows the D2 projection and can
never widen it.

### Trust and grants

An **install trust record** is kept per installed plugin:

```text
{ plugin, publisherKey | null, provenance: kontour | publisher | unsigned,
  contentDigest, tier: 2 | 3, grants[], decidedBy, decidedAt, affected }
```

- **Defaults.** Kontour-signed starts at tier 2 and unsigned at tier 3 (owner
  decision 3). The owner did not decide publisher-signed. Its default is
  OPEN-3; the proposed default is tier 3. Lowering is always allowed. Raising
  an unsigned plugin shows an explicit warning.
- **Tier maps onto the renderer capabilities that already exist.** The host
  offers capabilities per plugin, from its trust record, instead of one
  client-wide flag:
  - tier 2 may select `trusted-plugin-react`;
  - tier 3 may select only `sandboxed-plugin-frame` and `sandboxed-mcp-app`;
  - a tier-3 plugin that declares only an in-process renderer is
    `unavailable`, not silently promoted.
- **The tier confines browser code only.** `serverModule`, `providers` and
  agents run on the server whatever the tier. Pane-or-shell already records
  that the iframe does nothing for them. They remain separately derived,
  trusted-tier grants.
- **Pinning.** The record pins publisher key plus content digest.
  *2026-10-20:* for a Sigstore-signed plugin, "key" reads as the verified
  signer identity ([decision 1](#decision-1-open-4-signing-is-sigstore-keyless)).
  - An update with the same key, a new digest and no new capabilities keeps
    the tier and grants. Today's rebind already moves grants to the new
    digest.
  - An update signed by a different key is a new trust decision.
  - An update requesting any capability not previously granted re-prompts
    before its code activates. This closes "updates launder consent".
  - An unsigned plugin has no key, so every content change re-prompts.
  - *Exception (2026-10-20, OPEN-14):* a `kontour` plugin listed in
    `plugins.lock` receives the capabilities its lock entry lists with no
    prompt, at install and on update to a locked version. The review of the
    lock change stands in for the prompt
    ([decision 3](#decision-3-pluginslock-and-the-offline-default-set)).
    High-risk capabilities are excluded and still go through the consent
    listener (an engineering reading for owner confirmation). Any capability
    not in the lock entry re-prompts as above.
- **Who is affected.** On a shared Station, trust and grant prompts list the
  scope of effect: all members and all paired devices, because in-process
  code runs on every device that renders it. Lock pre-approved grants raise
  no prompt, so the plugin manager discloses them instead: each bundled
  plugin shows "granted by this Station's default set" with its capability
  list and the same scope-of-effect line. The operator is told what was
  granted and to whom it applies after the first start that installs
  bundled plugins, and again whenever the set of capabilities the lock
  grants grows (a new bundled plugin, or a locked version listing more
  capabilities).
- **Remote-Station bundles.** The device-local `remotePluginBundlesAllowed`
  store is **retired** in slice d3. A remote Station's bundles run on this
  device at tier 3 only. The store sits in `localStorage`, which admitted
  code can rewrite, and it records an origin, not a key and digest. Folding
  it into the operator's record would not help either: the operator of the
  remote Station is not the person whose device runs the code. An in-process
  admission for a remote Station would need a device-side record outside
  webview-writable storage, and this record does not design one.

#### Tier 2 is the kernel's own realm

Tier 2 is not just a realm that plugins share with each other. A tier-2
plugin runs in the shell's own document, with:

- the operator's session credential;
- the shell DOM, including every kernel surface drawn there;
- the SDK's credentialed client.

It can do anything the signed-in user can do from that device, and the
server cannot tell its requests from the user's. Four consequences follow:

1. **High-risk grants cannot be enforced against tier-2 code.** A tier-2
   plugin without `approvals.render` can still draw an approval card and call
   the decision route. Against tier-2 code the grant is a label that nothing
   derives.
2. **Limit 1's fixed kernel frame stops branding-based spoofing, not tier-2
   code.** A tier-2 plugin can draw a copy of the frame, or modify the real
   one.
3. **The server cannot tell a tier-2 plugin's approval from the user's.**
   `POST /tool-approval/:approvalId` accepts `{ approved }` from any caller
   holding the requesting session's authority, and tier-2 code holds it. A
   decision "refused when forged" can be refused only when it arrives from
   outside that authority.
4. **Raising a plugin to tier 2 grants full session authority, approvals
   included.** The raise prompt must say exactly that, in those words, for
   every plugin: "This plugin will be able to act as you in Station on every
   device that shows it, including approving agent actions."

The honest design consequence:

- **High-risk grants mean two things only:**
  - (a) a gate on which installs may be *raised* to tier 2 at all; a plugin
    whose manifest requests one needs a tier-2 decision to hold it;
  - (b) enforcement for tier-3 and server-side contributions, where a
    boundary exists to enforce it.
- Illustrative names (OPEN-7): `approvals.render` (fill the approval slot)
  and `layout.primaryChat` (be a layout's `primary: 'chat'` renderer).
- **The server-side approval authority must not rely on a decision rendered
  in the client realm alone.** Options are in OPEN-11. The record's own
  proposal is option (b): a kernel-owned confirmation, outside the shell
  document, for high-risk approvals. The record also states plainly that
  ordinary approvals stay decidable by tier-2 code for as long as tier 2
  exists.

### Shared Stations

The operator owns installation, trust and the D2 grants. Members get a
personal hide or disable layer and nothing else. A distribution manifest's
defaults are operator choices by delegation. They apply only when the
operator installs the manifest.

### Layouts: owner × subject

| Case | Owner | Subject | State |
| --- | --- | --- | --- |
| Project layout | project | that project | exists |
| Board | principal | none | exists |
| Instance-shared Board | instance | none | storage only |
| Personal project layout ("bring your own lens") | principal | project | new |
| Personal template | principal | unbound; binds when opened on a project | new |

Contract:
- Add an optional `subject` beside `owner`. A project owner implies its own
  project as subject.
- Derive the subject in one exported function, the way `layoutOwner()`
  derives the owner. Principal-owned records without a subject keep reading
  as Boards.

Rules:
- **No new access.** A personal project layout may reference only panes the
  principal can see (D2 plus membership), and its panes run with the
  principal's own project access. It is invisible to other members, and its
  existence is not disclosed to them.
- **Project policy** is a per-project setting: `personalLayouts: 'off' |
  'project-panes' | 'allowed-plugins'`.
  - The default is `project-panes`: the project's own panes only.
  - `allowed-plugins` lets members add panes from the plugins the project's
    `manage-extensions` holder allows.
  - Tightening the policy hides non-conforming personal layouts. It does not
    delete them.
- **Clone** copies a project layout to a new principal/project record under a
  new id. The source is untouched.
- **Save as my layout** is clone with the subject cleared, producing a
  template.
- **Promotion** remains a move, never a copy.

### Layout contract fields

Any layout, built-in or contributed, may declare three fields:

- `primary?: 'chat'`
  - The layout claims the centre for chat.
  - While it is mounted, the shell suspends the dock's chat, as it does
    today only for `chat`-kind layouts.
  - ⌘D (`dock.toggle`) focuses the layout's chat instead of toggling the
    dock.
  - Requires the `layout.primaryChat` grant when contributed.
- `presentation?: 'stack' | 'tabs'`
  - `stack` is the Chat → drill-in navigation stack with a breadcrumb and an
    icon rail.
  - `tabs`, the default, is today's tab host.
- `drillIns?: paneId[]`
  - The panes a `stack` layout may push.
  - Each must resolve through the ordinary pane availability check.

The shell honours these fields generically. When Coding ships as a plugin,
every `type === 'coding'` site listed in the current state is deleted, and
the Coding layout is expressed as `primary: 'chat'`, `presentation: 'stack'`
plus its drill-ins.

### Distribution manifests

A distribution manifest is a plugin package whose manifest carries a
`distribution` contribution with these sections:

- **plugins**: name, pinned version, and required publisher key.
- **extends**: another manifest to inherit and override, *or*
  **replaces**: the manifest it supersedes.
- **defaults**, **setup** and **branding**: see the table below.
- **policy**: trust defaults within the owner's bounds, the default
  personal-layout policy, and the layout catalog, which produces a
  `DistributionProfile`.

Precedence, highest first:

1. The operator's local choices. Today's lifecycle overrides in
   `config/distribution-lifecycle.json` are already this layer for the
   catalog.
2. The distribution manifest, child over parent.
3. Plugin defaults.

"Reset to distribution defaults" clears layer 1 for the chosen sections and
never touches trust records. Installation works at first run or later, from
Settings, from the CLI, or declaratively from configuration as code.

**Trust inside a manifest.** A manifest may *propose* trust defaults, and
the install prompt shows them. It cannot pre-grant:

- The operator's approval of the manifest covers the trust it lists, shown
  item by item.
- A manifest may not set an unsigned plugin to tier 2 without that plugin's
  own explicit warning.

#### What a distribution manifest may set

| Area | Item | State today | Evidence |
| --- | --- | --- | --- |
| Brand | Product name | exists (browser sidebar only; falls back to "Station") | `branding.getAppName`, [useBranding.ts](../../src-ui/src/hooks/useBranding.ts) |
| Brand | Logo and marks | partial (sidebar logo) | `branding.getLogo` |
| Brand | Favicon and `<title>` | needs a hook (static in `src-ui/index.html`) | [index.html](../../src-ui/index.html) |
| Brand | Theme tokens and colour roles | exists (five roles; contrast-checked) | [branding-theme.ts](../../src-ui/src/lib/branding-theme.ts) |
| Brand | Typography within the token contract | new (not in the allowlist) | — |
| Brand | Splash | new | — |
| Brand | Copy | needs a hook (small catalog, many literal "Station" strings) | [catalog.en-US.ts](../../src-ui/src/i18n/catalog.en-US.ts) |
| Setup | Onboarding steps and copy | needs a hook (code-defined steps) | [tour-steps.ts](../../src-ui/src/components/first-run/tour-steps.ts) |
| Setup | Welcome message | exists, unused by any view | `branding.getWelcomeMessage` |
| Setup | Empty states, help and docs links | needs a hook | e.g. [ChatEmptyState.tsx](../../src-ui/src/components/chat/ChatEmptyState.tsx) |
| Setup | Sign-in providers and pairing policy (configuration only) | exists as operator deployment configuration; needs a manifest hook | [deployment authentication](../guides/deployment-authentication.md) |
| Defaults | Agents, providers and models, MCP servers, skills, commands | needs a hook (`ISettingsProvider.getDefaults` has no caller found) | [provider-interfaces.ts](../../src-server/providers/provider-interfaces.ts) |
| Defaults | Default plugins and their settings | partial (catalog `preinstalled`/`enabled` for layouts only) | [distribution-profile-service.ts](../../src-server/services/plugins/distribution-profile-service.ts) |
| Defaults | Home | exists as a consent-gated role grant; slot override is new | [plugin-home-role-routes.ts](../../src-server/routes/plugins/plugin-home-role-routes.ts) |
| Defaults | Project templates | partial (Starter Work is a closed set) | [starter-work guide](../guides/starter-work.md) |
| Defaults | Region defaults | exists in code only | [placement defaults](placement.md#defaults-2156) |
| Defaults | Notification and email templates | none exist (push payloads are composed in code; no email) | [notification-delivery.md](notification-delivery.md) |
| Policy | Locale default | exists (en-US plus a pseudo-locale) | [i18n](../../src-ui/src/i18n/LocaleContext.tsx) |
| Policy | Telemetry default | tier foundation exists (`AppConfig.telemetryTier`); manifest policy consumption remains designed | [usage-telemetry-service.ts](../../src-server/services/usage-telemetry-service.ts) |
| Policy | Update channel | build-time (ADR 0020); a manifest may only recommend | [ADR 0020](../adr/0020-distribution-two-trains-channels-as-pointers.md) |
| Policy | Legal links (terms, privacy) | new | — |

Sections that are "exists" are grounded on existing seams:

- **brand** compiles to a `branding` provider answer;
- **sign-in** writes the existing OIDC configuration file shape;
- **catalog policy** produces a `DistributionProfile`.

The manifest adds no second path for any of these.

#### Limits (design rules)

1. **Kernel surfaces are not fully rebrandable.** Safe mode, trust and consent
   prompts, approval prompts, and sign-in and credential recovery keep a fixed,
   recognizable Station frame. That frame shows a provenance line naming the
   active distribution manifest and its publisher.
   - Branding may tint these surfaces. It may not replace the frame, the
     wordmark, or the provenance line.
   - Reason: a manifest that could restyle a trust prompt could also imitate
     one. The consent listener already serves consent pages from a distinct
     origin and does not read branding. That property must hold, and the
     in-shell prompts must meet the same rule.
   - This limit constrains *branding*. It does not constrain tier-2 code,
     which runs in the same document as the in-shell frame (see
     [tier 2 is the kernel's own realm](#tier-2-is-the-kernels-own-realm)).
     Only the distinct-origin consent pages are out of tier-2 reach.
2. **Native binary identity is build-time.** The desktop, iOS and Android app
   name, icon and bundle id live in build configuration (`tauri*.conf.json`,
   the Apple project). A distribution manifest cannot change them.
   - A company that wants its own app identity needs a white-label **build**.
     That is a separate path, and no documented one exists today.
   - Channels already produce parallel identities (ADR 0020), which is the
     precedent such a build would follow.
3. **Brand rules still apply.** Tokens must pass the same checks as
   white-label themes:
   - AA contrast for text roles and 3:1 for focus;
   - status colours are not in the allowlist, which keeps product colour
     separate from status colour.
   - When a manifest's tokens fail, the shell refuses the whole theme and
     keeps defaults, the rejection path `branding-theme.ts` already has.
   - Since #2952, Station validates themes with `@kontourai/ui`'s
     `validateBrandOverride` (pinned `^1.16.0` then, `^1.18.0` now), plus
     Station's stricter text rule for the action fill. A manifest's tokens
     pass through the same check.
   - The package's DESIGN.md (shipped in 1.16.0) states both rules this limit
     relies on. "White-label overrides" requires a runtime-applied theme to
     reject a pair that fails the AA text and non-text thresholds.
     "Product color is identity, not status" keeps product accents out of
     state.

A manifest may choose and configure sign-in. It never implements credential
verification, sessions or access recovery. Those remain kernel code.

### Safe mode

Safe mode is a kernel boot state. Station enters it when:

- the operator requests it: a CLI flag, a Settings action, or a reserved URL
  that plugins cannot claim;
- or no required slot and no working layout can be resolved even after
  default-filler fallback.

It mounts:

- the shell frame;
- sign-in and connection recovery;
- Settings;
- the plugin manager, where an operator can disable, roll back or uninstall;
- a read-only view of trust records.

It loads no plugin browser code. A distribution manifest cannot disable,
restyle beyond tint, or hide it. Home does not depend on safe mode: the Home
slot's default filler covers a broken Home override.

### The public repository

`kontourai/station-plugins`:

- `plugins/<name>/`: one package each, released independently and signed
  keylessly by the repository's release workflow through Sigstore (OPEN-4,
  resolved 2026-10-20);
- `distributions/kontour-default/`: the default manifest;
- the `acme-distribution` example, in that repository's examples folder: extends kontour-default, swaps the Coding
  layout and Home, and sets branding and SSO configuration;
- `templates/plugin-starter/`.

Station's CI installs pinned released versions, never workspace sources,
through `plugins.lock` ([decision 3](#decision-3-pluginslock-and-the-offline-default-set)). The
repository is public, so its fixtures use generic names and hosts.

## Threat notes: what operator discretion cannot cover

- **Tier 2 is the kernel's realm.** An operator who raises a plugin to tier 2
  gives it the user's session, the shell DOM and the approval route (see
  [above](#tier-2-is-the-kernels-own-realm)). No grant, frame or prompt
  inside that document constrains it afterwards. Only content pinning, the
  distinct-origin consent pages and server-side re-validation outside the
  credential still hold.
- **Approvals decided from the client realm.** `POST
  /tool-approval/:approvalId` accepts `{ approved }` from any caller holding
  the requesting session's authority, which tier-2 code does.
  Once any tier-2 plugin exists, the server cannot attribute an approval to a
  person. This is OPEN-11.
- **Consent cannot attest a person.** Any caller holding a Station credential
  can preview and install, including an agent with a shell tool
  ([authority model](plugin-authority-model.md#where-consent-belongs)). A
  trust *raise* or a high-risk grant must therefore be decided on the
  distinct-origin consent listener, like the Home role, not on an ordinary
  authenticated route. Otherwise "the operator raised it" is not a fact.
- **Module resolution is shared with the kernel's realm.** Every bundle's
  shim assigns `globalThis.require`, so the first in-process plugin loaded
  controls how later plugins resolve `react` and the credentialed SDK client.
  This is one visible instance of the realm problem above, not a separate
  plugin-to-plugin issue (OPEN-2).
- **Digest pinning covers bytes on disk, not code fetched at runtime.**
  [`plugin-content-integrity.ts`](../../src-server/services/plugins/plugin-content-integrity.ts)
  states this limit. The remaining nonce assignment on the cross-origin
  inline path is how in-process code mints undeclared scripts.
  - *This record's reading* of the owner's condition ("fix the CSP-nonce
    handoff before claiming sandboxed") is that it is already met for tier-3
    frames, which receive no nonce.
  - It still gates any claim that a tier-2 pin bounds what runs.
- **Server-side contributions are unconfined at every tier.** Only disclosure
  and grants bound them.
- **Paired devices inherit tier-2 code.** An in-process plugin runs with the
  rendering device's session on every device. This is why trust prompts must
  state who is affected.
- **`ui.confirm` draws plugin-supplied text inside shell chrome.** Under limit
  1 it must stay visually distinct from kernel prompts, or be retired.
- **A distribution manifest is code-adjacent configuration.** It selects
  plugins, sign-in configuration and trust proposals, so installing one is a
  trust decision of the same weight as its most-trusted plugin.

## Relationship to existing records

- **[pane-or-shell.md](pane-or-shell.md)**
  - Its runtime tiers stand as the vocabulary.
  - "Tier 2 is first-party packages" is superseded: the tier is chosen per
    install, informed by provenance. Its "trusted third-party tier remains a
    possible future" becomes this decision.
  - Its Home row moves from "pane" to "required slot filled by a plugin".
- **[plugin-authority-model.md](plugin-authority-model.md)**
  - Open question 2 is answered by the owner: install consent starts at full
    trust for Kontour-signed plugins and sandboxed for unsigned ones, per
    install, and the operator can change either. The publisher-signed default
    remains open (OPEN-3).
  - "Updates launder consent" is addressed by re-prompting on new
    capabilities and a new key.
  - Its per-contribution question (1) keeps its answer: panes are confinable,
    `serverModule` only disclosable.
  - Its "attribution is the missing ingredient" argument is why high-risk
    grants cannot be enforced at tier 2.
- **[shell-ownership-and-boards.md](shell-ownership-and-boards.md)**
  - D1 gains the subject axis, clone, templates and project policy. D2 stands
    and gains a personal hide/disable layer.
  - Its open question "Should Home become the viewer's default Board?" is
    replaced by the Home slot.
  - Its non-goal "No new plugin contribution types" is lifted for the
    `distribution` contribution and the layout contract fields.
- **[terminal.md](terminal.md)** owns the terminal: the session store,
  `TerminalView`, and (in its #3894 amendment) the closed `terminal` pane
  target with `pane:builtin:coding:terminal` as a presentation alias. The
  Coding plugin uses that public surface (decision 2 of 2026-10-20). Its
  phase 4 places the Coding drawer; under that decision the drawer's
  presentation is plugin code and the terminal stays core. That record does
  not yet carry a dated cross-reference to this one.

## Coding capability map (condensed)

Source inspection at `e880e9c92` on 2026-10-20.
`src-ui/src/components/coding-layout/` has 29 non-test TS/TSX files (plus 11
CSS files) that import **60** distinct app-internal modules. Plugins cannot supply a layout
renderer today: every contributed layout renders through `LayoutView`, and a
contributed layout typed `coding` is deliberately refused the built-in host
([project-layout-kind.ts](../../src-ui/src/app-shell/project-layout-kind.ts)).
So Coding cannot ship as "a plugin that renders CodingWorkbench". The
workbench chrome becomes slice a's generic host in core, and the plugin
contributes a layout declaration and its panes.

Disposition codes: **HOST** (absorbed by slice a's generic host), **SDK**
(an existing or new SDK capability; the slice is named), **REF** (a core pane
opened by descriptor), **KIT** (the UI kit), **SHARED** (a pure helper moving
to `@kontourai/station-shared` or into the plugin).

| Family | What `coding-layout/` imports today | Disposition |
| --- | --- | --- |
| Layout host, navigation, chat placement | navigation store, chat placement, `CodingChatPane`, `ChatDock`, pane-host reducer, commands and open context, region chrome slots | HOST (a). Plugin-initiated opens go through SDK-4 (#3875) |
| Pane head actions | `PaneHeadSlots` (a React portal) | SDK-1: a declarative `usePaneHeadActions`, because #3875 bars React slots from crossing the capability |
| Panel and device state | `layout-panels-record`, device settings, `transcriptMeasure` | a2 (a generic panel record keyed by layout, retiring the pre-release `codingPanels` preferences); SDK-6 for the plugin's own per-device state |
| Device facts | `useIsMobile`, `useDockSlotDevice`, mobile viewport, menu focus | SDK-1 (`useHostFacts`); viewport and menu focus are HOST or KIT |
| Shortcuts | `useKeyboardShortcut`, `KeyboardShortcutsContext` | SDK-1. The SDK's `useKeyboardShortcut(s)` exist but throw for plugins: `SDKAdapter.tsx` passes `hooks: {}` and wires no shortcuts context |
| Chat interop | `ActiveChatsContext` drafts, `CodingFilesContextProvider`, `ACPChatPanel`, `useACPConnections`, `useRecentAgents` | SDK-3 (`useChatComposer`, `useChatContextAttachments`); the chat pane by descriptor (SDK-4); ACP connections are already in the SDK; recent agents become plugin-local on SDK-6 |
| Git and repositories | `useGitActions`, `useGitStatus` | SDK-2 (repositories, branches, checkout, commit, push). `useGitStatusQuery` already exists. Commit and push stay operator-only on the server |
| Files and preview | `FilePreviewPane`, the file-preview intent, the browser-preview launcher, clipboard, `PromptModal` | The file-preview plugin (jF), opened by descriptor through SDK-4; SDK views (`FileView`); browser preview by descriptor (REF, slated to become its own plugin); SDK-1 (`host.clipboard`, `host.prompt`) |
| Diff | `DiffPanel` and its performance hooks; diff-comment data | SDK views (`DiffView`); the diff and diff-comment queries are already public |
| Terminal | `browserWebSocketAuth`, `@xterm/*`, `errorText` | The core `terminal` target via SDK-4, or SDK-5's `TerminalView`; both owned by [terminal.md](terminal.md) and gated by the caller's own terminal grants **[security]**; `errorText` is SHARED |
| PR review | `pull-requests/*` components, `openExternalLink`, `useUnsavedGuard`, `useTickingNow`, request-authority scope | The PR review plugin (jP), opened by descriptor through SDK-4; SDK views (PR review data hooks); SDK-1 (`host.openExternal`, `useRequestAuthorityScope`); SDK-4 (`useUnsavedGuard` bound to #3875's close guard); KIT (row, chips, relative time) |
| Evidence | `WorkflowPlanPanel`, `ReadinessPanel`, `TrustPanel` | REF: the core plan, readiness and trust panes. Only the inspector composition moves |
| UI primitives | `Button`, `IconButton`, `Tabs`, `ActionOverflowMenu`, `LazyBoundary`, `ResponsiveDialogSurface`, `state`, `icons/Glyph`, `ConfirmModal`, `isComposingKeyEvent` | KIT; dialogs become `host.confirm`, `host.prompt` and `host.menu`; `isComposingKeyEvent` is SHARED |

**Every `type === 'coding'` special case** and its equivalents, to be
deleted or replaced in j:

| Site | Replacement |
| --- | --- |
| `src-ui/src/app-shell/project-layout-kind.ts` (lines 32, 87, 130) | Derive the kind and chat placement from `primary` and `presentation`. Keep the rule that a contributed layout cannot claim a built-in host |
| `src-ui/src/app-shell/ProjectLayoutRenderer.tsx` (lines 521, 1719), with `BuiltinCodingLayoutHost` (:437, about 1,200 lines) and its imports at :8-22 and :60-68 | Slice a's generic stack host |
| `src-ui/src/components/chat-dock/useChatDockViewModel.ts:266` (read by `ChatDock.tsx` as `sessionCodingLayout`) | A contracts helper, `findPrimaryChatLayout(layouts)` |
| `src-ui/src/views/ProjectPage.tsx:271` | The same helper |
| `src-ui/src/views/home/useHomeViewModel.ts:251` | The same helper |
| `src-ui/src/components/project-sidebar/ProjectLayoutChips.tsx:271` | The layout's own icon field |
| `src-ui/src/workspace-panes/LayoutWorkspacePane.tsx:318` | "Main only" derived from `presentation: 'stack'` |
| `src-ui/src/workspace-panes/workspacePaneDirectRoute.ts:18` | A descriptor flag such as `directRoute` |
| `src-ui/src/workspace-panes/builtinWorkspacePaneCanonical.ts` (lines 89-91, 106, 151, 168, 480; the `:coding` descriptor-id suffix checks and the `builtin:coding` source id) | Deleted with the built-in `coding` renderer |
| `src-ui/src/regions/region-surface-panes.ts` (lines 305-309, 321; the architecture ratchet's source map, not a type check) | Repointed at the plugin's panes |
| `packages/contracts/src/layout.ts:268-275` (`BUILTIN_CODING_LAYOUT`) | Replaced by the bundled plugin's contribution (i0); the docstring's promise is restated |
| `packages/contracts/src/workspace-pane-builtin-renderers.ts:31-34` | Remove `coding` and the three Coding pane renderer names |
| `packages/contracts/src/workspace-coding-{file,diff,evidence}-composition.ts` (`resolveBuiltinCoding*Grant`) | These grant only when `provenance.origin === 'builtin'`, so a plugin pane would be **denied**. Replaced by install-time capability grants (jG) **[security]** |
| `src-server/routes/projects/layout-working-directory.ts:61` (and `codingLayoutRepoId` at :79), `project-layout-admission.ts:114`, `projects.ts:627` | A layout field, `workspaceBinding?: 'repository'`, so admission derives from the declaration (a2) **[security]** |
| `scripts/coding-composition-inventory-gate.mjs` | Retired or repointed in j |

`App.tsx:464` mentions `'coding'` only in a comment. It consumes
`resolveLayoutChatPlacement` and changes with it.

## Open items

"Proposed" marks a default suggested by the coordinating review of this
record on 2026-09-29. It is a proposal awaiting the owner, not a decision.

- **OPEN-1. Exact slot set.** Is the approval surface one slot with the
  primary chat, or its own? A split lets a third-party chat exist without
  approval-render authority.
  *Proposed:* approvals is its own required slot, separate from chat.
- **OPEN-2. Module resolution in the kernel's realm.** The shared
  `globalThis.require` shim
  ([build.ts](../../packages/shared/src/build.ts);
  [authority model](plugin-authority-model.md#a-threat-no-disclosure-can-express))
  lets any in-process plugin substitute the modules later plugins, and
  kernel-adjacent code, resolve. Fixing the shim (per-bundle resolution from a
  host-frozen table) removes one attack path. It does not change the
  tier-2 conclusion above, because tier-2 code can reach the originals
  anyway. Options:
  - fix the shim as hygiene and keep the tier-2 statement unchanged;
  - load the approval-slot filler before any operator-raised plugin, and
    accept that ordering is not a boundary;
  - restrict tier 2 to Kontour-signed plugins while any high-risk slot is
    filled in-process.
- **OPEN-3. Publisher-signed default.** The owner fixed defaults for
  Kontour-signed and unsigned only. `keyId` is a label, not a verified
  publisher identity ([registry-trust-policy.md](registry-trust-policy.md)).
  *Proposed:* publisher-signed plugins start sandboxed; only Kontour's key
  starts trusted.
- **OPEN-4. Kontour key custody: resolved 2026-10-20.** Sigstore keyless:
  no long-lived Kontour plugin key. station-plugins' release workflow signs
  with its GitHub OIDC identity, and Station pins that identity and verifies
  the bundle with its inclusion proof. Rotation is identity pinning with an
  overlap window; revocation is a digest and identity denylist shipped in
  each release (an engineering reading awaiting owner confirmation).
  `kontour` provenance needs the pinned identity and a `plugins.lock`
  entry. ADR 0020's updater keys are unaffected. See
  [decision 1](#decision-1-open-4-signing-is-sigstore-keyless). The
  original question ("'Kontour-signed' needs a shipped anchor key, a
  rotation rule and a revocation path") is answered by the pinned identity
  and the embedded Sigstore root. **Still open:**
  - a revocation feed between releases, and what signs it;
  - whether online Stations refresh Sigstore's root through TUF
    (*proposed:* no; embedded root only, refreshed per release, at the cost
    that a Station older than a Sigstore key rotation must update before
    installing plugins signed after it);
  - whether online installs also query Rekor for log consistency
    (*proposed:* no);
  - the operator UX for reading and pinning a third-party identity;
  - issuers other than GitHub Actions, and private Sigstore deployments.
- **OPEN-5. Who installs project layouts: adopted 2026-10-20.** The owner
  said "admin or operator", but `manage-extensions` belongs only to `owner`
  today. The owner adopted the proposal: add a project-scoped "manage
  layouts" permission held by project `owner` and `admin`; instance installs
  stay owner-only. Slice **b** owns it, since b already changes per-project
  policy and role checks; it needs its own route tests for the refusal path.
  j does not depend on it: until b lands, project owners install Coding as
  they can today.
- **OPEN-6. Sign-in in a manifest.** A manifest may configure the kernel's
  OIDC adapter. Selecting an authentication *module*
  (`STATION_AUTHENTICATION_MODULE`) loads code into the kernel's sign-in
  path.
  *Proposed:* a manifest may configure sign-in; selecting a code module needs
  a trusted install plus an explicit operator grant.
- **OPEN-7. Grant names and vocabulary.** `approvals.render` and
  `layout.primaryChat` are illustrative. The typed permission vocabulary
  (archive#3534) may own them.
- **OPEN-8. Instance-shared Boards authorship.** Carried from
  shell-ownership-and-boards.
  *Proposed:* the operator, plus members the operator grants it to, may author
  instance-shared Boards.
- **OPEN-9. Member hiding of a slot override.** May a member hide an
  operator-overridden Home and see the default filler instead?
  *Proposed:* no. Members may not hide the operator's Home override.
- **OPEN-10. Brand rule source: resolved on main.** #2952 bumped
  `@kontourai/ui` to `^1.16.0`, which ships DESIGN.md, and
  `branding-theme.ts` now calls the package's `validateBrandOverride`. The
  rules limit 3 cites were read in that package. The proposal to bump the
  package in slice h is overtaken.
- **OPEN-11. Approval decisions from the client realm.** The server accepts a
  tool-approval decision from any caller holding the requesting session's
  authority, which includes every tier-2 plugin. Options:
  - (a) Decide every approval on a kernel-owned channel outside the shell
    document: the distinct-origin consent listener, or a native dialog on
    desktop and mobile. This is strongest and costs a context switch per
    approval.
  - (b) Re-confirm only high-risk approvals on that channel. Examples are
    full-access posture, destructive tools, and anything an approval policy
    marks. Ordinary approvals stay decidable in the shell.
  - (c) Allow tier 2 only for Kontour-signed plugins while approvals are
    decided in-shell, so the realm holds only code Kontour signed.
  - (d) Accept and disclose: tier 2 equals the user. The raise prompt says so,
    and nothing else changes.

  **Answered 2026-10-22:** the owner selected (b): high-risk approvals use a
  kernel-owned channel; ordinary approvals stay in the shell. The additional
  disclosure in every raise prompt remains this record's proposal, not part
  of that owner answer. Implementation and approval-extraction proof remain
  pending.
- **OPEN-12. Terminal interim for j: answered 2026-10-20.** No interim. j
  waits for the SDK `TerminalView` (SDK-5); the Coding plugin renders it or
  opens the core closed terminal target. See
  [decision 2](#decision-2-everything-in-coding-moves-into-the-plugin).
- **OPEN-13. File preview and PR review: answered 2026-10-20.** Each ships
  as its own plugin in the bundled default set (slices jF and jP), used by
  chat and Coding alike.
- **OPEN-14. Grants for bundled plugins: answered 2026-10-20.** The owner's
  answer: pre-approved by lock. Each lock entry lists the plugin's
  capabilities, and a `kontour` plugin listed in the lock gets exactly those
  with no prompt. Engineering readings, for owner confirmation: anything
  beyond them prompts, and high-risk capabilities are excluded from
  pre-approval and decided on the consent listener. Because the lock now
  grants authority, it needs the owner-performed required reviewer rule
  first ([decision 3](#decision-3-pluginslock-and-the-offline-default-set)).

## Delivery plan

The [consolidated delivery plan](../plans/plugin-core-delivery.md) tracks the
single feature branch and its remaining implementation and acceptance work.

The owner requested consolidation into one feature-branch PR, #4046, then
renewed the instruction to land existing qualified PRs on 2026-10-23. That PR
contains an implemented subset; landing it does not complete #2993. The slices
below remain implementation and acceptance units for the unfinished epic. **[security]** marks a slice
that touches a security boundary and needs an independent security review
before merge.

**Common acceptance criteria for every slice:**

- Every named test fails when the slice's behavior is reverted, and the pull
  request records that fault injection.
- An existing user's persisted state survives the slice. Where a slice
  changes how stored data is read, it names a migration test that starts
  from a fixture in the exact shape today's writer produces.
- The slice updates the guides, references and review-ledger records it
  affects. Documentation is not deferred to slice m.

| Slice | Depends on | Security |
| --- | --- | --- |
| a. Layout contract fields and generic host | — (coordinate with #3875) | |
| a2. Workspace binding field and a generic panel record | a | [security] |
| b. Owner × subject | — | [security] |
| c. Board UX | b (for save-as) | |
| d1. Trust records, signer and digest pinning, migration | #1521, OPEN-4 (resolved 2026-10-20) | [security] |
| d2. Per-plugin capabilities, high-risk class, update re-prompt | d1 | [security] |
| d3. Raise on the consent listener; retire the remote-bundle store | d1 | [security] |
| d4. Cross-origin nonce fix | — | [security] |
| e. Required-slot resolver | — | [security] |
| f. Safe mode | e | [security] |
| g. Distribution manifest, precedence, reset | d1, OPEN-4 (resolved) | [security] |
| h. Distribution branding and defaults | g | [security] |
| SDK-1. Host services | — | [security] |
| SDK-2. Git and repositories query domain | — | |
| SDK-3. Chat composer and context attachments (shared with #3049) | — | [security] |
| SDK-4. Pane open, reveal and close; unsaved guard | owned by #3875 | |
| SDK-5. Terminal session store, `TerminalView` and the `terminal` target | owned by [terminal.md](terminal.md) and #3875 | [security] |
| SDK-6. Plugin device state | coordinate with #1359 | |
| SDK-views. Diff view, file view, PR review data | — | |
| KIT. UI kit upstream to `@kontourai/ui` | a `@kontourai/ui` release | |
| i0. Offline bundled default set from `plugins.lock` | d1, d2, d3, i1, jG, and the owner's lock-review prerequisite | [security] |
| i1. station-plugins repo scaffold and starter template | — (its CI carries its own standalone verifier) | [security] (release signing) |
| i2. Board extraction as an installed plugin, with migration | d1, i1, i0 | [security] |
| i3. kontour-default and acme manifests | g, h, i2 | [security] |
| R. Growth-only ratchet on `coding-layout/` app-internal imports | — | |
| jG. Capability grants and legacy pane-id adoption (Coding, file preview, PR review) | d1, d2 | [security] |
| jF. File preview → its own default plugin, with migration | i0, jG, SDK-1, SDK-4, SDK-6, SDK-views, KIT | [security] |
| jP. PR review → its own default plugin, with migration | i0, jG, SDK-1, SDK-4, SDK-views, KIT | [security] |
| j. Coding → plugin, with migration | a, a2, i0, i2, jF, jP, jG, SDK-1, SDK-2, SDK-3, SDK-4, SDK-5, SDK-6, SDK-views, KIT | [security] |
| k. Home → plugin, with migration | e, i2 | [security] |
| l. Inbox/Chat → plugin, approval decisions | a, d2, e, j, OPEN-11 | [security] |
| m. Plugin authoring | docs part: —; signing and registry: d1 | [security] (signing) |

Browser and Device panes follow i2's pattern as their own slices. SDK-4 is
built by the #3875 lane and SDK-5 by [terminal.md](terminal.md)'s phases;
this plan consumes them and does not build a second version of either.

j has no edge to i3: its proof is self-contained, using a fixture
replacement layout, and the acme replacement stays i3's proof. i0, jG and
SDK-views prove themselves with fixture plugins, so none waits on j.

Owners of moves that the decision 2 table names:

| Move | Owner |
| --- | --- |
| Plan, readiness and trust content out of `CodingInspectorPanel.tsx` into `flow/`, `readiness/`, `trust/` | SDK-views |
| `planSession` (`selectWorkflowPlanSession`) into core | SDK-views |
| `chatContextDraft.ts` start-message helpers into core chat start | SDK-3 |
| The "manage layouts" permission (OPEN-5) | b |

### a. Layout contract fields and a generic host

- Add `primary`, `presentation` and `drillIns` to the layout contract, with
  parsers that refuse unknown values.
- The shell derives dock suspension and ⌘D routing from `primary`, and the
  host from `presentation`.
- Built-in Coding declares the fields and keeps rendering unchanged.

Acceptance:

- A fixture plugin layout (not Kontour, loaded from a test plugin directory)
  declaring `primary: 'chat'`, `presentation: 'stack'` and two drill-ins
  behaves exactly like built-in Coding:
  - the dock chat is suspended;
  - ⌘D focuses the layout chat;
  - the breadcrumb and icon rail work;
  - Back pops the stack.
- The parser refuses `primary: 'terminal'` and a drill-in id that does not
  resolve.

Proof: a real-browser parity spec that runs the same assertions against
built-in Coding and against the fixture layout. Reverting the generic
derivation (so only `type === 'coding'` works) must fail the fixture half.

*Implemented in source (2026-10-25, #2995).* What was built, and the readings
the slice settled:

- **Contract.** `packages/contracts/src/layout.ts` adds the three fields and
  `parseLayoutPresentationDeclaration`, which refuses an unknown `primary` or
  `presentation`, a malformed, duplicate or unresolvable drill-in, more than
  16 drill-ins, and `drillIns` or `primary: 'chat'` without
  `presentation: 'stack'` (no other host renders the layout's Chat, so the
  dock would be suspended with nothing in its place). The catalog parser and
  the installer both run it; the installer also refuses a Chat claim from a
  plugin that does not request `layout.primaryChat`.
- **Drill-ins** resolve, in this slice, only to the layout's own tabs' panes,
  and a drill-in whose Project occurrence id would exceed the pane host's and
  navigation store's 128-character limit is refused (#4130).
  Opening another contributor's pane by reference is the extraction slices'
  (REF in the capability map).
- **Grant.** `layout.primaryChat` is an ordinary install-time plugin
  permission of the `active` tier. This uses today's grant store; d2's
  per-plugin capability records may later absorb it.
- **Reads, not records.** The declaration is response-only: every Project
  layout read states the contributor's declaration (built-in starter or
  installed plugin, `primary` only with the grant), and writes strip it, so
  no request body can claim a Chat centre. The contributing plugin is the
  one the server-owned `catalogContribution` names; `config.plugin` alone
  selects nothing. A stored built-in Coding record
  that states nothing reads as Coding's declaration — the one explicit legacy
  rule, in `layoutPresentationDeclaration`, for j to delete.
- **Shell.** `project-layout-kind.ts` chooses the stack host from
  `presentation` and the Chat centre (dock suspension, ⌘D) from `primary`.
  `LayoutStackHost` in `ProjectLayoutRenderer.tsx` is the generic host;
  built-in Coding's own composition (`builtinCodingStack.tsx`) is added only
  for the non-contributed record. `useChatDockViewModel` and
  `useHomeViewModel` use `findPrimaryChatLayout`.
- **Not replaced here:** `ProjectPage.tsx`'s lookup routes Coding's own
  Files/Diff/Terminal panes and stays until those panes move (#3009);
  `RelatedPaneStrip.tsx` returns to Coding's Files the same way. The
  conditional default placement from the owner's comment on #2995 (Diff
  docked on the right when the workspace has changes) is not built.

### a2. Workspace binding field and a generic panel record [security]

The server workspace-binding portion is implemented in source: Project layout
creation, updates, reads and catalog application accept the repository binding
and retain legacy Coding restrictions. See [the current API](../reference/api.md#layout-management).
The generic `layoutPanels` record is also implemented in source, keyed by
Project/Layout host scope and conversation. Panel slots are side/lower rather
than Coding-specific. On 2026-10-21 the owner chose to reset old panel preferences
to generic defaults, superseding the preservation requirement below. The v3
device envelope removes the obsolete `codingPanels` field; no compatibility
bucket or deferred adoption remains. This does not complete the generic host
presentation or Coding extraction.

- Add `workspaceBinding?: 'repository'` to the layout contract. A layout
  declaring it gets the working directory derived from its project, and a
  write that sets `config.workingDirectory` is refused. This replaces the
  three server checks of `type === 'coding'`
  (`layout-working-directory.ts`, `project-layout-admission.ts`,
  `projects.ts`).
- The declaration derives a path; it grants no file access. File and diff
  authority stay with the grants in jG; terminal authority stays with the
  caller's own `terminal:operate` / `terminal:observe` (terminal.md).
- Replace the `codingPanels` device-settings record with a generic panel
  record keyed by layout, which slice a's host owns.
- **Migration:** a stored `type: 'coding'` layout without the field reads
  as `workspaceBinding: 'repository'`, whether or not the Coding plugin is
  installed, so the plugin's absence never loosens admission. A stored
  obsolete `codingPanels` visibility/size preferences reset to generic defaults
  in the v3 device envelope (owner choice, 2026-10-21).

Acceptance:

- A fixture layout declaring `workspaceBinding: 'repository'` receives the
  project's derived working directory. A write setting
  `config.workingDirectory` on it is refused with today's error.
- A stored `type: 'coding'` layout in today's exact shape, with no
  `workspaceBinding`, is still refused a `config.workingDirectory` write
  with the Coding plugin uninstalled.
- A v2 device envelope containing `codingPanels` upgrades to v3 without that
  field. Unrelated preferences survive, and each layout starts with generic
  panel defaults. Generic panel choices subsequently survive reload and stay
  independent across layouts and conversations.

Proof: server route tests for the derivation and both refusals, and a
migration test from today's device-settings fixture. Reverting the
derivation to `type === 'coding'` must fail the fixture-layout test.

### SDK-1. Host services [security]

- Wire keyboard shortcuts for plugins: `useShortcut({ id, keys, when, run })`
  registers in the host registry, so the palette and help list it and an
  open modal suppresses it; `useShortcutScope(name)` sets scopes such as
  terminal focus. Today `SDKAdapter.tsx` passes `hooks: {}`, so the SDK's
  `useKeyboardShortcut(s)` throw for plugins.
- `useHostFacts()`, exposing the pane host's device facts such as
  `isMobile`.
- `host.clipboard.writeText`, `host.openExternal(url)` (routed through the
  native opener on desktop and mobile, with a scheme allowlist),
  `host.prompt({ title, label, initial })` returning a string or `null`,
  and `host.menu(items)`.
- `usePaneHeadActions([{ id, label, icon, overflow? }], onAction)`: plain
  data, so it can cross a frame boundary. #3875 bars React slots from
  crossing the capability.
- `useRequestAuthorityScope()`.
- Every new capability joins the `station dev` SDK mock and its parity
  test (#3895).

Acceptance:

- A fixture plugin's shortcut appears in the palette and the shortcut help,
  and does not fire while a modal is open.
- `host.openExternal('javascript:…')` and other non-allowlisted schemes are
  refused. On desktop an allowed URL goes to the native opener, not
  `window.open`.
- `host.prompt` resolves `null` on cancel.
- Head actions render in the pane head and move to the overflow menu as
  width shrinks.

Proof: component tests in the host for each capability, a real-browser spec
for the shortcut and head-action fixture, and the mock parity test. Removing
the shortcut wiring must fail the palette assertion.

### SDK-2. Git and repositories query domain

- Move `useGitActions` into an SDK query domain: `useReposQuery`,
  `useGitBranchesQuery`, `useGitCheckoutMutation`, `useGitCommitMutation`,
  `useGitPushMutation`, with `DiscoveredRepo` and `GitBranch` types. They
  call the existing `/api/coding/repos` and `/api/coding/git/*` routes.
- The server routes and their authority are unchanged: commit and push stay
  operator-only.

Acceptance:

- A fixture plugin lists repositories and branches and checks out a branch.
- A commit from a principal who is not the operator is refused by the
  server, exactly as from the app today.
- The app's own Git UI uses the SDK hooks (no second client).

Proof: SDK hook tests against a test server, and a route test of the
refused commit through the SDK path.

### SDK-3. Chat composer and context attachments [security]

Shared with #3049, which needs the same surface for diff comments that
become agent context.

- `useChatComposer(): { activeChatId, getDraft(), appendToDraft(text, { source }) }`.
  The host applies its redaction to appended text and labels it with its
  source.
- `useChatContextAttachments(): { attach(file), detach(id), list }`.
- Wire or remove the unwired `useActiveChatState`.
- Move the start-message helpers in `coding-layout/chatContextDraft.ts`
  (used by `NewChatModal.tsx:82`) into core chat start, so `NewChatModal`
  stops importing `coding-layout/`.

Acceptance:

- Text appended by a fixture plugin appears in the active chat's composer
  with its source label.
- A secret-shaped string in appended text is redacted by the host before it
  reaches the draft.
- A plugin cannot read or write a draft other than the active chat's.

Proof: host tests for redaction and the active-chat bound, and a
real-browser spec for append and attach. Bypassing redaction must fail the
redaction test.

### SDK-4. Pane open, reveal and close; unsaved guard

Owned by the #3875 lane: `host.panes.open/reveal/close(target)` answering
`opened`, `focused`, `replaced` or `unavailable`, and `useUnsavedGuard(dirty)`
bound to its close guard. This plan consumes it. Core callers that open file
preview switch to it in jF, callers that open PR review in jP, and callers
that open Coding panes in j.

### SDK-5. Terminal session store, `TerminalView` and the `terminal` target [security]

Owned by [terminal.md](terminal.md): the store is its transport phase; the
view export, the closed `terminal` pane target and its sample plugin are in
its layout phase as amended by #3894, and the target depends on #3875. The
caller's own `terminal:operate` / `terminal:observe` grants gate every open.
The Coding plugin opens the target or renders `TerminalView`; it adds no
terminal code or grant of its own. j depends on this slice with no interim
(OPEN-12, answered 2026-10-20). terminal.md's own status line reads
"Proposal — unscheduled; no tracking issue as of 2026-10-20", so j cannot
be scheduled until those phases are.

### SDK-6. Plugin device state

- `usePluginDeviceState<T>(key, parse)`: per plugin and per device,
  namespaced by plugin identity. A failed parse returns the default.
- Coordinate with #1359's persistent data service, so there is one storage
  owner with a bounded lifecycle.

Acceptance:

- Two plugins using the same key do not see each other's values.
- A stored value that fails `parse` yields the default and does not throw.
- Uninstalling the plugin removes its device state.

Proof: host tests for isolation, parse failure and uninstall cleanup.

### SDK-views. Diff view, file view, PR review data

- Host-implemented components exported from the SDK: `DiffView` (with diff
  comments) and `FileView`. They run on the host's syntax-highlighting
  worker and performance hooks, which a plugin bundle cannot carry.
- PR review data hooks over the existing routes in
  `src-server/routes/pull-requests/` (review guide and conversation links),
  beside the existing `usePullRequestsQuery` and
  `usePullRequestContextQuery`.
- `TaskWorkspaceView` adopts `DiffView` and `FileView` and stops importing
  `coding-layout/`.
- Move the plan, readiness and trust content components out of
  `coding-layout/CodingInspectorPanel.tsx`, and `planSession`, into
  `flow/`, `readiness/` and `trust/`, so the core evidence panes stop
  importing `coding-layout/`.

Acceptance:

- A task workspace renders its diff and file views through `DiffView` and
  `FileView`.
- The plan, readiness and trust panes render from their core domains, placed
  in a fixture layout with no Coding panes.
- A fixture plugin renders `DiffView`, and a diff comment it adds reaches
  the same store the app uses.

Proof: a fixture-plugin component test, and a structural scan that
`src-ui/src/views/` and the evidence-pane registrations import nothing from
`coding-layout/`, paired with a real-browser spec of a task workspace. Until j removes `coding-layout/`
from `src-ui`, the spec alone cannot tell the SDK view from the compiled-in
panel, so re-importing `DiffPanel` in `TaskWorkspaceView` must fail the
scan.

### KIT. UI kit upstream to `@kontourai/ui`

- In the public `kontourai/ui` repository: add Tabs, IconButton, an overflow
  menu, RelativeTime and the glyph set to `@kontourai/ui/react`, and release.
- In Station: move Button, IconButton, Tabs, Empty and Skeleton onto the
  package (ErrorState only if one is also added upstream; 1.20.1 has none);
  add `@kontourai/ui/react` to `SHARED_EXTERNALS` and
  `SHARED_EXTERNALS_REGEX`, to the runtime shim in `pluginSharedRuntime.ts`,
  and to the `station dev` mock in `template-scripts.ts`; load its styles
  once from the host.
- Mark `@kontourai/station-components` deprecated: the plugin build warns on
  an import of it, and it stays resolvable through a deprecation window.

Acceptance:

- A plugin built with the starter marks `@kontourai/ui/react` external, and
  at runtime its import is the same module object the host uses.
- The same plugin runs under `station dev`, whose mock supplies the module.
- A plugin importing `@kontourai/station-components` builds with a
  deprecation warning and still runs.
- Station's own components render from the package (no duplicate
  implementations remain for the moved primitives).

Proof: a build test asserting the external, a runtime identity test in the
shared-runtime suite, and a structural scan paired with those behavioral
tests.

### b. Owner × subject [security]

Implementation reading: the [contracts reference](../reference/contracts.md#personal-project-layouts-2996)
records the source API, additive stored-shape migration and evidence owners.
Personal Project layouts remain in the caller's personal listing; template
opening returns a bound read view without persisting it. This does not complete
Board UX (#2997), independent security review or release qualification.

- Add a `subject` contract field with one derivation function.
- Add the project-scoped "manage layouts" permission for `owner` and
  `admin` (OPEN-5, adopted 2026-10-20), with route tests for its refusal
  path.
- Personal project layouts, templates, clone, and the per-project
  `personalLayouts` policy (default `project-panes`).

Acceptance:

- Member A's personal layout on project P is not listed to or fetchable by
  member B. The fetch answers as for a nonexistent slug.
- A personal layout referencing a plugin pane A cannot see is refused at
  write time and withheld at read time.
- Under `project-panes`, an outside plugin pane is refused. Under
  `allowed-plugins`, it is allowed only from the allowed list.
- Clone leaves the source unchanged.
- A template opened on P binds to P without writing to P.
- Migration: existing Boards (principal-owned, no subject) read unchanged.

Proof: server route tests with two authenticated principals. Removing the
subject check or the policy check must fail them. A fixture of today's Board
record must round-trip.

### c. Board UX

- The Boards section header and `+` are always visible, including with zero
  Boards.
- Add or arrange panes on a Board, from the D2-visible set, via the existing
  `PUT /api/me/layouts/:slug`.
- Reorder Boards.
- "Save as my layout" (from slice b).
- Instance-shared Boards: route and UI for their authors (OPEN-8), listed
  after personal Boards and marked shared.

Acceptance:

- A new user with zero Boards sees the `+`.
- Adding a pane persists across reload and a second device.
- Reorder persists.
- A principal without authorship cannot create or edit an instance Board
  (403). A member sees it as read-only.

Proof: a real-browser spec for the first-Board path and add-pane, and route
tests for instance-Board authority. Hiding the `+` again must fail the first.

### d1. Trust records, signer and digest pinning, migration [security]

- Add the install trust record, with provenance from verified signatures.
  This depends on #1521 consuming verified claims, and on OPEN-4, resolved
  on 2026-10-20 as Sigstore keyless
  ([decision 1](#decision-1-open-4-signing-is-sigstore-keyless)).
- Pin to signer plus digest. A signer is a verified Sigstore identity or a
  registry ed25519 key.
- Add a Sigstore bundle verifier that loads an embedded `trusted_root.json`
  directly (no TUF client), with the pinned Kontour identity, the
  `plugins.lock` names, and the release-shipped denylist. Verification makes
  no network request.
- **Migration:** every plugin installed before d1 gets a grandfathered record
  at its current effective tier, marked `grandfathered`, with its current
  digest and the tier it runs at today. The plugin manager surfaces
  grandfathered records for an explicit operator decision. Nothing drops to
  tier 3 silently, and no existing pane mounts `unavailable` because of d1.

Acceptance:

- A new unsigned install records tier 3.
- A new install whose Sigstore bundle verifies against the pinned Kontour
  identity, and whose name has a `plugins.lock` entry, records `kontour`
  provenance and tier 2. The same identity with a name not in the lock
  records `publisher`.
- A valid bundle from any other identity records `publisher`. So does one
  from a repository with the pinned name but a different repository id.
- A bundle without an inclusion proof, or with a proof that does not verify,
  is refused.
- A bundle with no verified timestamp (neither a Rekor v1 signed entry
  timestamp nor an RFC 3161 timestamp) is refused, and so is one whose
  timestamp falls outside the Fulcio certificate's validity window. A Rekor
  v2 entry with an RFC 3161 timestamp is accepted.
- A denylisted digest or identity is refused at install and at activation.
- A changed digest from the same signer keeps the tier.
- A different signer produces a new, untrusted decision.
- A Station upgraded with an in-process plugin already installed still
  mounts that plugin in-process, and lists it as grandfathered.

Proof: installer unit tests per rule, using real Sigstore bundles recorded
from a test signing run (not hand-built shapes), with the network
unavailable during verification. A migration test starts from today's
installation and grant files (exact writer shape) and asserts the pane still
selects `trusted-plugin-react`.

**d1 delivery is split in two (2026-10-24).**

- **Part 1 (#2998, first PR): verification and decision rules.** This part
  has no production caller yet, and its exports carry `UNWIRED(#2998)`
  markers.
  - [plugin-sigstore-verifier.ts](../../src-server/services/plugins/plugin-sigstore-verifier.ts)
    verifies a bundle offline with `@sigstore/verify` against the embedded
    [public-good trusted root](../../src-server/services/plugins/sigstore-public-good-trusted-root.json).
  - [plugin-install-trust.ts](../../src-server/services/plugins/plugin-install-trust.ts)
    holds the pinned identities, the minimal `plugins.lock` membership,
    provenance, and the tier decision.
- **Part 2a: install-time records (server).**
  - [plugin-install-trust-store.ts](../../src-server/services/plugins/plugin-install-trust-store.ts)
    keeps one record per plugin in `plugin-trust.json`, through the same
    fail-closed store as `plugin-grants.json`.
  - The installer decides trust before any effect and writes the record as
    its last fallible step
    ([plugin-install-trust-recording.ts](../../src-server/services/plugins/plugin-install-trust-recording.ts)).
    Provenance comes from that install's own verification: a delivered
    Sigstore bundle verified against the consented source digest, else the
    registry receipt's ed25519 signer, else unsigned. The stored record
    supplies only the earlier signer and tier.
  - A delivered bundle that does not verify refuses the install; it never
    falls back to unsigned. No production acquisition delivers a bundle
    until i0.
  - [plugin-install-trust-migration.ts](../../src-server/services/plugins/plugin-install-trust-migration.ts)
    runs at start, before plugin providers load. It also runs at the entry of
    every install, of the raw registry copy, and of the legacy git or registry
    update.
    - **The first attempt freezes the pre-d1 set.** It freezes every plugin
      installed before d1, each with the digest of its bytes at that moment.
      It writes a grandfathered tier-2 record, with that digest and the
      receipt's signer, for each one it can read.
    - **Later attempts grandfather only frozen bytes.** A frozen plugin whose
      manifest or receipt cannot be read now stays pending and is retried on
      a later start. It is grandfathered only if its bytes still match the
      frozen digest.
    - **Unread bytes are never grandfathered.** Bytes that could not be read
      at the freeze were first seen after it. They are never grandfathered and
      read as `unrecorded`, as do bytes that changed since the freeze.
    - **Mismatches are unrecorded.** A plugin whose manifest names another
      plugin, or whose bytes disagree with its journal digest, is
      `unrecorded`, not grandfathered.
    - **The frozen set is bounded.** The journal and the file marker each
      store at most 1024 plugins and refuse a larger set when written; they
      never truncate it. If more than 1024 plugins were installed before d1,
      the first attempt grandfathers none of them, logs an error and
      completes. It records the count in the `$migration` marker
      (`skippedOverBound`), and every plugin without a record then reads
      `unrecorded` with `grandfatheringSkipped`, so the operator is told why.
      Each is decided again, which fails closed without locking installs out.
  - **Where the migration stands is kept in the installation journal**
    (EventStore), as well as in the file's `$migration` marker.
    - **Why the journal.** It is in every production composition, already
      holds installation authority, and does not go away with
      `plugin-trust.json`. The home schema version was the alternative. It
      was rejected because a bump makes older Station builds refuse the home.
    - **The journal is written first.** The journal records the frozen set
      before the file is written. Every journal step is compare-and-set
      against the state the attempt read, so two first attempts cannot both
      freeze. The file write rechecks the journal under its lock. A failed
      journal write fails the attempt. An attempt that loses that race to a
      concurrent first attempt retries once against the state the winner
      recorded.
    - **A failed first file write is rebuilt.** The journal also records
      whether the frozen set has reached the file. Until it has, a missing
      file means the first file write never landed (a crash, a full disk, a
      read-only home), and the next attempt rebuilds the file from the
      frozen set. It grandfathers only frozen plugins whose bytes still match
      their frozen digest, exactly as a later attempt does.
    - **A missing file fails closed once it was written.** After the frozen
      set reached the file, a missing `plugin-trust.json`, or one without its
      marker, is unavailable rather than empty. Deleting or editing the file
      therefore never re-grandfathers anything, and installs refuse with
      `503`. The refusal names the recovery: restore the file from a backup,
      or create it containing only a completed marker,
      `{"$migration":{"version":1,"startedAt":"2026-01-01T00:00:00.000Z","pending":[]}}`.
      A completed marker is final even while the journal still says the
      migration is under way, so after that recovery every plugin reads
      `unrecorded` until it is decided again. That only ever grants less
      trust.
    - **Do not delete the migration journal.** The journal row lives in the
      EventStore database. Deleting it together with `plugin-trust.json`
      leaves no record that the migration ever ran, so the next start runs a
      first attempt again and grandfathers every plugin installed at that
      moment at tier 2, including bytes installed after d1. Recover with the
      completed marker above instead.
  - **Records are versioned per record.** This build writes `version: 1`. A
    build that adds a decision kind, reason or field writes a higher
    version. A reader that does not know a record's version reads that one
    record as `unreadable`; it never rejects the whole file for it (even
    under a key grammar it does not use), and an install or update over an
    `unreadable` record is refused with `409 plugin-trust-record-newer`, so
    an older build cannot replace a newer build's lower tier with its own
    provenance default. A `$migration` marker of a higher version reads as a
    completed migration. A `version: 1` record or marker with an unknown
    field or value is still malformed, and the file is unavailable.
  - **A record must be one a writer produces.** Beyond its field shapes, a
    `version: 1` record is malformed (the file is unavailable, as for any
    malformed record) when provenance is `unsigned` but a signer is present
    or the reverse, `kontour` lacks a Sigstore signer, tier 2 has neither a
    `grandfathered` decision nor a Sigstore signer, a grandfathered record is
    not tier 2, a prior tier appears outside a new decision, or `decision` or
    `decidedBy` is a value no writer stores. A Sigstore-signed `publisher`
    record may stay at tier 2: a same-bytes reinstall keeps the earlier tier
    after a plugin leaves the lock. This is defence in depth; anything that
    can write the home can also replace the plugin's bytes.
  - **A malformed record names its remedy.** The 503 names the entry and
    says to delete it from `plugin-trust.json`. That plugin then reads
    `unrecorded` (no trust) until it is reinstalled or updated; every other
    record is untouched. A malformed `$migration` marker names the
    completed-marker recovery instead.
  - **Paths that write no record.** Four paths copy, pull or rebuild bytes
    outside the transaction:
    - a Station-format dependency installed by `plugin-source.ts`;
    - the raw registry copy (`POST /api/registry/agents/install`);
    - the legacy git or registry update (`POST /api/plugins/:name/update`);
    - an in-place rebuild of an installed dependency.

    They are not routed through the decision. Each runs the migration first
    (an in-place rebuild happens inside an install that already did). The
    record is then invalidated by derivation: a plugin with no record after
    the migration is `unrecorded`, and a record whose digest differs from the
    installed bytes is `stale` (`pluginTrustForInstalledBytes`).
    - **Who computes it today.** The installer uses that derivation to decide
      whether an earlier record still describes the installation it
      replaces. 2b's listing projects it. Nothing that decides how a plugin
      renders reads it yet: d2 must wire it into renderer selection.
  - **A record survives uninstall.** A later install of that name is compared
    against it.
    - The earlier tier carries over only when the record described the bytes
      installed when the install took the content lock. A reinstall after
      uninstall, or a tree whose bytes differ from the record, therefore never keeps a tier above
      what its own provenance allows (a new decision,
      `tier-exceeds-provenance`).
    - The record and the bytes before the install are read under the content
      lock. The global publication lease, taken before the trust decision is
      prepared, already refuses a second install while one is in flight.
  - A reinstall of the same bytes under the same signer keeps the earlier
    decision as it was, including a pending new decision, its reason and its
    prior tier.
  - Nothing reads the tier yet: renderer selection is unchanged until d2, so
    no pane changes how it mounts.
- **Part 2b: exposure and operator decision.** It projects records to
  `GET /api/plugins` and the SDK, and adds the plugin-manager surface where
  the operator decides each grandfathered record, with screenshots.
- **Part 2c: the denylist,** refused at install and at activation.

Engineering readings in part 1, for review:

- **Bundle shape.** Only a Sigstore bundle v0.3 holding a DSSE in-toto
  Statement v1 with an SLSA provenance v1 predicate is accepted. That is
  what `actions/attest-build-provenance` produces. The artifact digest must
  be a `sha256` subject of that statement. A message-signature bundle (as
  from `cosign sign-blob`) is refused as `unsupported-bundle`, so slice i1's
  release workflow must attest SLSA provenance.
- **Issuer.** Only GitHub Actions certificates are read, because each pinned
  field is a Fulcio GitHub Actions extension. Other issuers stay open under
  OPEN-4.
- **The pinned repository must be public.** GitHub sends a private
  repository's attestations to its own Sigstore instance, which has no
  transparency log, and the verifier refuses a bundle with no log entry. i1
  must create `kontourai/station-plugins` as a public repository.
- **Which workflow is pinned.** The certificate SAN (the signing job's
  workflow) must be the pinned file in the pinned repository at the
  triggering ref. The build config URI (the run's top-level workflow) must
  equal it too. So neither a reusable workflow elsewhere nor another
  workflow calling the pinned file through `workflow_call` matches.
- **What a signer is.** A pinned Sigstore signer is the workflow: the
  certificate SAN without its `@ref`, plus the issuer and the numeric
  repository and owner ids. Successive releases are therefore the same
  signer. An ed25519 signer is its SPKI fingerprint; the `keyId` is a label.
  The signer omits the ref, trigger and runner, so on its own it never grants
  tier 2. A changed digest keeps the earlier tier only up to what the new
  install's provenance allows: a non-`kontour` update of a tier-2 plugin is a
  new decision at tier 3. Without that rule, the pinned workflow dispatched
  on any branch would inherit tier 2. An operator's raise of a publisher
  plugin is therefore decided again on every update.
- **Conditions Station checks itself.** Before the library runs, Station
  checks for at least one transparency-log entry, an inclusion proof with a
  checkpoint on every entry, at least one timestamp, and every timestamp
  inside the certificate window. Each failure refuses with its own reason.
  These checks can only refuse. The library still verifies the chain, the
  SCT, the timestamps, the proofs, the entry body and the signature.
- **Accepted edge case: an `unchanged` reinstall keeps its tier.** A
  reinstall of the same bytes under the same signer keeps the recorded tier,
  even if the plugin has since been dropped from the lock or Station no
  longer pins its identity. It changes at the plugin's next update. Revoking
  a delisted plugin is i0's job: i0 recomputes provenance against the running
  release's lock on every start.
- **Inputs.** The verifier takes the raw bundle bytes and refuses more than
  512 KiB before parsing. Production verifiers use only the embedded root;
  the constructor that accepts another root is named and documented as
  test-only.
- **Pins and lock in production.** Station pins no identity until
  `kontourai/station-plugins` exists (i1), because its repository id is not
  yet known. Part 1 ships no production pin list, so no install can be
  `kontour`. With no pins, every lock entry is refused.
- **The snapshot step.** The trusted root is refreshed only by
  `node scripts/sigstore-trusted-root-snapshot.mjs`. The script takes
  `gh attestation trusted-root` output, which gh fetches through
  sigstore-go's TUF client and verifies against gh's embedded TUF root. It
  keeps the single public-good root, and the change is reviewed in a PR.
  `--check` reports drift.
  - Running the snapshot inside the release build, as decision 1 describes,
    is not wired yet.
- **Rekor v2.** The library accepts a Rekor v2 entry with an RFC 3161
  timestamp. No real Rekor v2 DSSE fixture was available, so that
  acceptance case is not yet tested.

### d2. Per-plugin capabilities, high-risk class, update re-prompt [security]

- The host offers renderer capabilities per plugin from its trust record,
  replacing the client-wide frames flag.
- d2 must treat a plugin that is `unrecorded`, or whose record is `stale`
  (its digest differs from the installed bytes), as untrusted: tier 3 until
  the operator decides. Some install paths write no record (see d1 part 2a),
  so the record alone is not proof that it describes what will render.
- The high-risk grant class, enforceable for tier-3 and server-side
  contributions. For tier 2 it gates the raise only.
- An update requesting any new capability does not activate until consent
  is given. Exception (OPEN-14): capabilities listed in the plugin's
  `plugins.lock` entry, for a `kontour` plugin, are pre-approved. d2 owns
  this pre-approval rule and its re-prompt, and reads capabilities in the
  lock format that
  [decision 3](#decision-3-pluginslock-and-the-offline-default-set)
  defines; its tests use a fixture lock, so d2 does not depend on i0. The
  exclusion of high-risk capabilities from pre-approval, and where their
  consent is given, belong to d3.

Acceptance:

- A tier-3 plugin cannot select `trusted-plugin-react`.
- An update adding `agents.invoke` stays inactive until consent is given.
- Against a fixture lock: a `kontour` locked plugin updated to a locked
  version gets the lock entry's capabilities with no prompt, and a
  capability beyond its entry re-prompts.
- The same update listing a high-risk capability (`agents.invoke`) in its
  lock entry keeps that capability inactive until consent is given. (Where
  consent is given, and the exclusion rule itself, are d3's.)
- A tier-3 plugin requesting `approvals.render` is refused.

Proof: frame-mount and installer tests, each failing when its rule is
reverted.

### d3. Raise on the consent listener; retire the remote-bundle store [security]

- Raising a plugin to tier 2, and any high-risk grant, is decided only on the
  distinct-origin consent listener. Lock pre-approval (OPEN-14) never covers
  a high-risk grant, so this holds for bundled plugins too. d3 owns that
  exclusion and tests it against a fixture lock, so d3 does not depend on
  i0.
- The prompt uses the exact tier-2 disclosure wording from
  [tier 2 is the kernel's own realm](#tier-2-is-the-kernels-own-realm) and
  lists who is affected.
- Retire `remotePluginBundlesAllowed`: remote-Station bundles run at tier 3
  on the device.
- **Migration:** a device that had admitted a remote Station's bundles sees
  them in frames, or `unavailable` with a reason, and is told why once.

Acceptance:

- A raise sent to an ordinary authenticated route is refused.
- Against a fixture lock: a high-risk capability listed in a locked
  plugin's entry is not granted until it is decided on the consent
  listener.
- The consent page shows the disclosure text.
- A persisted `remotePluginBundlesAllowedKey` entry in `localStorage` no
  longer admits in-process code.

Proof:
- a route test for the refused raise;
- a consent-page render test asserting the disclosure string;
- a browser test with the legacy `localStorage` key set, asserting no
  in-process remote bundle loads.

### d4. Cross-origin nonce fix [security]

- Serve cross-origin bundles by URL, or refuse them. Drop the nonce
  assignment in `executeBundleInline`.

Acceptance:

- No plugin script element carries the shell nonce on any path.

Proof: a CSP test covering the cross-origin path. Restoring the assignment
must fail it.

### e. Required-slot resolver [security]

Implementation note (#3002): [required slots](../guides/plugins.md#required-home-and-inboxchat-slots)
now models the built-in Home and shared Inbox/Chat pane as defaults. Existing
Home-role grants are adapted on every installation read; the original consent
file is retained. The shared UI host reports non-authoritative default-failure diagnostics;
slice f must establish its own kernel-owned recovery channel.
Distribution preferences do not assign roles, and bundled extraction remains
k/l. OPEN-1's approval-slot split remains undecided. Source and focused tests
are separate from independent security and hosted qualification.

- One resolver for the required slots (OPEN-1). It is derived on every read
  from the live installation.
- Overrides can be added and removed. The default filler can be neither
  uninstalled nor disabled.
- The resolver returns the safe-mode result for an unavailable default. Home
  computes selection refusal; Chat mounts its built-in directly. Neither
  production caller computes a module-load failure. Default render errors retain the pane frame’s recovery actions. Renderer
  diagnostics report the third default boundary catch per pane occurrence,
  including render/effect/update crashes and a failing remount after Chat’s
  Close clears the conversation. The count persists across healthy renders,
  elapsed time, and conversation changes; the third catch emits once. Removing
  the occurrence from the host document, or switching the host to another
  document, prunes its history. A standalone frame retains history until that
  frame unmounts; Chat placements without a pane frame report no repeated-render
  diagnostic. Home’s Close navigates away.

Acceptance:

- The parser and installer reject each of these, and a test pins each
  rejection:
  - a manifest or configuration that sets a slot to null, empty or `none`;
  - uninstalling a default filler;
  - disabling a default filler.
- A broken, disabled or uninstalled override resolves to the default filler.

Proof: resolver unit tests and route tests for the refusals. A resolver
that can return an empty slot must fail them.

### f. Safe mode [security]

- Kernel boot state with explicit entry: a CLI flag, a Settings action and a
  reserved URL.
- Automatic entry when no working layout resolves, a default cannot load or
  be selected, or the initial default render failure is followed by two failed
  explicit retries. Two retries allow transient recovery without an endless
  crash loop; a successful render resets the count and Close remains usable.
- Recovery signals and retry accounting must come from a kernel-owned channel.
  Never consume `station:required-slot-safe-mode` window events or the slice e
  renderer diagnostic callbacks as authority. A granted in-page Home plugin
  can forge or suppress same-realm observations; module privacy does not solve
  that trust boundary. Slice e removed the window event and exposes only
  module-local diagnostics. Slice f must validate kernel-owned failure state
  independently, including the claimed pane and retry sequence.
- It loads no plugin browser code.
- Add its path to the reserved plugin identities.

Acceptance:

- With every plugin, default fillers included, failing to load, Station
  boots into safe mode showing the plugin manager.
- In safe mode, no plugin bundle request is made.
- Forged or suppressed renderer diagnostics and DOM events cannot trigger or
  prevent kernel recovery. One conversation render crash retains Retry/Close
  and does not enter safe mode.
- An operator can disable a plugin and leave.
- A plugin claiming the safe-mode path is refused at install.

Proof: a real-browser spec with a broken plugin set, asserting both the
rendered surface and zero bundle requests. Removing the automatic entry must
fail it.

### g. Distribution manifest, precedence and reset [security]

- Add the `distribution` contribution kind:
  - plugins with pinned versions and signers (identity or key);
  - extends or replaces;
  - a policy section that produces a `DistributionProfile`;
  - trust proposals shown item by item at install.
- Three-layer precedence.
- "Reset to distribution defaults".
- Install at first run, later, or from configuration.
- **Migration:** a Station with an inline `distributionProfile` and no
  manifest keeps its catalog exactly.

Acceptance:

- A child manifest's override beats its parent.
- An operator's local lifecycle choice beats both, and survives reinstalling
  the manifest.
- Reset clears local choices for the chosen sections and leaves trust
  records unchanged.
- A manifest pinning a signer that does not match the fetched plugin is
  refused before any tree write.
- The legacy inline profile fixture produces the same catalog as before.

Proof: installer and precedence unit tests, one route test with a mismatched
key, and a catalog-equality test for the legacy profile.

### h. Distribution branding and defaults [security]

- Manifest sections for brand, setup and defaults, grounded on the existing
  `branding` provider, the theme validator, the OIDC configuration file and
  the profile service.
- New hooks for favicon, title, onboarding copy, empty states, help links and
  legal links.
- A fixed kernel-prompt frame with a provenance line.
- Use the `validateBrandOverride` path that #2952 landed; add no second
  validator.

Acceptance:

- The acme example changes the product name, logo, favicon, theme tokens and
  onboarding copy. Each is asserted from the rendered DOM and computed
  styles.
- Under acme branding, the kernel prompts (consent, approval, sign-in
  recovery, safe mode) keep the Station frame and the provenance line
  "acme-distribution by <publisher>". A theme that tries to hide or restyle
  the frame beyond tint is refused.
- A low-contrast token set is refused as a whole and the defaults stay. A
  rendered-contrast assertion on the kernel frame's text meets AA under the
  acme theme.

Proof: a real-browser spec asserting the computed values above, and unit
tests for the two refusals.

### i0. Offline bundled default set from `plugins.lock` [security]

**Owner prerequisite.** Before i0 starts, the owner adds a required
reviewer ruleset rule for `plugins.lock`, with the merge-queue behaviour
confirmed ([decision 3](#decision-3-pluginslock-and-the-offline-default-set)).
The reviewing team excludes accounts whose credentials automation holds,
which rules out the owner's own account as used today: every lock change,
bot bumps included, needs another human or a separate owner account that
agents never hold. That is a repository-settings change an i0 pull request
cannot make.

**Dependencies.** i0 builds the real lock, the release payload and the
start-time installer. It does not own the grant rules: d2 owns lock
pre-approval of listed capabilities and the re-prompt for anything beyond
them, and d3 owns the high-risk exclusion, each tested against a fixture
lock. jG owns per-plugin grants and legacy-id adoption. i0 depends on d1,
d2, d3, i1 and jG; d2 and d3 depend only on d1, jG on d1 and d2, and d1 on #1521. So
the graph is acyclic: no slice that i0 depends on depends on i0.

- Commit `plugins.lock`: per plugin, name, version, artifact URL, sha256,
  Sigstore identity (equal to the pinned identity) and capabilities.
- The Station release build fetches every locked artifact and its Sigstore
  bundle, checks both, and carries them in the release payload. A missing or
  unverifiable artifact, or an entry whose identity is not the pinned one,
  fails the build.
- **On every start**, with no network needed, the installer:
  - recomputes each installed plugin's provenance against the running
    release's lock;
  - installs every locked plugin that is missing and not marked uninstalled,
    verifying digest and bundle against the embedded trusted root, the
    pinned identity and the lock;
  - updates an installed `kontour` plugin whose installed version is older
    than the locked version to the locked version, offline. It never
    downgrades a newer version the operator installed.
- **Grants** (OPEN-14, answered): a `kontour` plugin listed in the lock gets
  exactly the lock entry's capabilities with no prompt, at install and at a
  version update, except high-risk capabilities, which go to the consent
  listener (d3). A capability beyond the lock's list prompts the operator
  through d2's re-prompt, and the plugin stays inactive until that prompt is
  answered. The plugin manager discloses lock-granted capabilities and who
  they affect (see [Trust and grants](#trust-and-grants)).
- **The uninstall record.** i0 owns it. When the operator uninstalls a
  bundled plugin, the installer writes a `bundledUninstalled` entry (plugin
  name) in the server's plugin installation state, beside the install
  records. A start never reinstalls a name with that entry. Reinstalling the
  plugin (from the plugin manager, the CLI, or the bundled payload) clears
  it. Disabling is different: a disabled plugin stays installed and
  disabled across starts and updates, and writes no uninstall record.
- **Dropped from the lock.** A plugin that the running release no longer
  locks loses `kontour` provenance at the next start (recomputed from the
  verified identity stored at install, without re-verifying signatures), and
  with it its legacy-id adoptions (jG) and its lock pre-approval. It is not
  removed. The plugin manager shows it as "no longer in this Station's
  default set" and asks the operator to keep it or uninstall it. Until then
  it is inactive, and panes that relied on an adopted id render
  `unavailable` with that reason.
  - **The prompt states the consequences before the operator chooses.**
    Keeping means:
    - the plugin runs at tier 3 (`publisher` provenance, OPEN-3's proposed
      default);
    - a plugin that declares only an in-process renderer, such as Coding, is
      `unavailable` until it is raised to tier 2 on the consent listener;
    - panes under adopted legacy ids stay `unavailable`, because adoption
      requires `kontour` provenance;
    - the capabilities the lock granted are **dropped** and re-prompted
      (this record's recommendation), because the lock review that stood in
      for consent no longer covers the plugin.
  - The prompt offers **Keep**, **Keep and raise** (which goes straight to
    the consent listener for the tier-2 raise and the re-prompted
    capabilities), and **Uninstall**.
  - The choice is persisted in the plugin's d1 trust record (the decision,
    who made it, when, and the release that dropped it), so the operator is
    not asked again on every start.
  - This is consistent with d1's "nothing drops to tier 3 silently": until
    the operator chooses, the plugin is inactive and flagged, not running at
    tier 3, and the move to tier 3 happens only through a choice whose
    consequences the prompt stated.
  - "Reinstall from the bundled set" is hidden for a dropped plugin; it is
    offered only for plugins in the current lock.
  - A dropped plugin that fills a required slot (Home, chat, approvals) is
    treated by slice e's resolver as a failed filler: an override falls back
    to the default filler, and a default filler that cannot resolve enters
    safe mode (slice f).
- **Name conflicts.** If an installed plugin has a locked name but is not
  `kontour` (for example a `publisher` plugin of the same name), it does not
  count as the bundled plugin. The installer does not replace it
  automatically; it surfaces a conflict in the plugin manager, and the
  bundled plugin stays uninstalled until the operator uninstalls the other
  one. Auto-replacing would let a start silently remove an operator's
  choice; leaving it unflagged would let a same-name plugin stand in for the
  bundled one.
  - Uninstalling the conflicting non-`kontour` plugin does **not** write
    `bundledUninstalled`; that record is only for a bundled plugin the
    operator removed.
  - After that uninstall, the bundled plugin installs **immediately**, in the
    same operation, rather than waiting for the next start, so the operator
    sees the outcome of the choice they just made.
  - The conflict entry offers "Install bundled" as the one-step action: it
    uninstalls the conflicting plugin and installs the bundled one, after
    one confirmation naming both.
- A bot PR bumps the lock.

Acceptance, with a fixture lock of test plugins signed by a test identity
that a test build pins (no dependence on Coding or j):

- A fresh Station with all outbound network refused installs the locked
  set, makes zero outbound requests (including to Sigstore and the plugin
  registry), and a project can create the fixture plugin's layout.
- The installed plugins hold exactly the lock entries' capabilities and no
  prompt was raised. A fixture whose manifest requests one capability beyond
  its lock entry is inactive with a prompt for that capability only.
- **Upgrade:** a Station data directory in today's exact shape, holding a
  stored project layout that the fixture plugin's migration claims, started
  on a build whose lock contains that plugin, installs it with no network
  and opens the layout unchanged.
- **Version update:** a Station with fixture version 1 installed, started on
  a build locking version 2, runs version 2 with no network; one with
  version 3 installed by the operator keeps version 3.
- **Uninstall record:** an uninstalled bundled plugin stays uninstalled
  across restarts; reinstalling clears the record; a disabled plugin stays
  disabled and installed.
- **Dropped from the lock:** a plugin locked in build A and absent from
  build B's lock is, on B, non-`kontour`, inactive, flagged in the plugin
  manager, and its adopted-id panes render `unavailable` with the reason.
- **Name conflict:** a `publisher` plugin with a locked name is left in
  place, a conflict is surfaced, and the bundled plugin is not installed
  until it is resolved. "Install bundled" replaces it in one step, writes no
  `bundledUninstalled`, and the bundled plugin is installed before the
  action returns.
- **Keep after drop:** the prompt shows the four consequences before the
  choice; a kept plugin is not asked about again on the next start, runs at
  tier 3 without its lock-granted capabilities, and a Coding-like fixture
  declaring only an in-process renderer is `unavailable` until raised.
  "Keep and raise" opens the consent listener for the raise.
- **Disclosure:** when build B's lock entry for a plugin lists one more
  capability than build A's, starting on B repeats the shared-Station
  disclosure; restarting on an unchanged lock does not.
- **High-risk:** with the real start-time installer, a lock entry listing
  `agents.invoke` does not grant it without a consent-listener decision
  (d3's rule, exercised end to end).
- A tampered artifact in the payload is refused, and Station still boots:
  the affected layout is `unavailable` with a reason (safe mode only when a
  required-slot default filler is affected, per slice e).
- CI fails when a locked artifact is missing or an entry's identity is not
  the pinned one.

Proof: end-to-end first-run, upgrade and version-update runs in an
environment with outbound network refused, asserting the request count, the
installed set, the granted capabilities and the opened layout; installer
tests for the uninstall record, the dropped-from-lock path and the name
conflict, each starting from installation state in today's exact writer
shape; a tampered-payload test; and a CI run against a missing artifact.
Removing the start-time install must fail the upgrade test; recording
provenance once instead of recomputing must fail the dropped-from-lock test;
auto-replacing must fail the name-conflict test.

### i1. station-plugins repo scaffold and starter template

- Create `kontourai/station-plugins` with `plugins/`, `distributions/`,
  `examples/` and `templates/plugin-starter`, plus its CI.
- Its release workflow signs each artifact keylessly through Sigstore (OPEN-4)
  and publishes the bundle beside the artifact. A tag ruleset governs release
  tags; the signing job runs in an environment with required reviewers; only
  the signing job holds `id-token: write`; and no `pull_request_target` or
  `workflow_dispatch` path reaches it. Examples, the starter and
  distributions are released by a separate workflow file.
- The signing job runs `actions/attest-build-provenance`, and it is a job
  defined directly in the pinned top-level release workflow file, triggered
  by the pinned event. Calling the action as a step, or through a composite
  action, is fine. Station refuses signing inside a reusable workflow,
  whether in the same repository or the SLSA generator: the certificate SAN
  then names the reusable file, not the pinned one. Pinning a reusable file
  instead is refused too, because the build config URI must equal the SAN.
  The repository must be public, or its attestations have no transparency
  log entry (d1).
- Its own CI carries a standalone verifier with the same identity policy
  Station pins, so i1 does not wait on d1.
- Its CI tests plugins against Station's published preview build.

Acceptance:

- The starter template builds and installs into a test Station through the
  ordinary consent install.
- A released artifact's bundle verifies, in the standalone verifier, against
  the identity Station pins.
- A bundle signed by the same workflow on a ref that does not match the
  pinned ref pattern fails that verification.
- The repository's settings show the tag ruleset, and no job other than the
  signing job declares `id-token: write` (a workflow scan).

Proof: the repo's CI builds the starter; a Station e2e test installs it; the
standalone verifier runs against a released bundle and against a bundle from
a non-matching ref, asserting exit status; and the workflow scan runs as a
child process.

### i2. Board extraction as an installed plugin, with migration [security]

- Move `board-pane` to station-plugins; `src-ui` no longer imports it.
- Station CI installs the version pinned in `plugins.lock`, and the Board
  plugin is part of i0's bundled set.
- **Migration:** D2 fails closed on plugin panes. Existing Boards, project
  layouts and dock placements that reference the Board pane keep rendering:
  the extracted Board plugin gets a grandfathered visibility grant for every
  principal who could see the built-in, and the pane id is preserved or
  mapped once. Both the grandfathered grant and the id preservation apply
  only to a Board plugin with `kontour` provenance (pinned identity and lock
  entry); any other plugin claiming the Board id gets neither.

Acceptance:

- A fresh Station renders the Console Board through the installer.
- `src-ui` has no dependency on the board package.
- A Station upgraded with a personal Board holding the Board pane still
  renders it for its owner.
- A non-`kontour` plugin declaring the Board pane id is refused the id and
  the grandfathered grant.
- CI fails when the pinned release is missing.

Proof:
- a dependency scan (structural, paired with the behavioral tests);
- an end-to-end install from the pinned release;
- a migration test from a Board record in today's exact shape.

### i3. kontour-default and acme manifests [security]

- Publish `distributions/kontour-default` and the `acme-distribution` example.
- Release signing is Sigstore keyless (OPEN-4, resolved 2026-10-20). The
  manifests pin signer identities, not keys.

Acceptance:

- A fresh Station installing kontour-default matches today's default
  experience.
- acme extends it, swaps the Coding layout and Home, and sets branding and
  SSO configuration.
- A tampered artifact fails verification in CI.

Proof: e2e install of both manifests, and a CI run against a tampered
artifact.

### R. Growth-only ratchet on `coding-layout/` app-internal imports

While #3039's Coding work continues, every new app-internal import into
`coding-layout/` adds to what j must replace.

- A scan in the style of the existing ratchets (`scripts/*-ratchet.mjs`
  with a checked-in baseline) records each (importing file, imported
  app-internal module) pair under `src-ui/src/components/coding-layout/`.
- It fails only when a pair is added. Removing a pair never fails, and the
  baseline is keyed on module paths, never on line numbers, so it cannot
  fail whoever merges next under the merge queue.
- Retired in j, when the directory leaves `src-ui`.

Acceptance: adding an import of a new app-internal module to a
`coding-layout/` file fails the check with the pair named; removing one
passes.

Proof: the ratchet run as a child process against a fixture tree with one
added pair (non-zero exit, pair named) and one removed pair (zero exit).

### jG. Capability grants and legacy pane-id adoption [security]

- Replace the `resolveBuiltinCoding*Grant` checks in
  `workspace-coding-{file,diff,evidence}-composition.ts`, which grant only
  when `provenance.origin === 'builtin'`, with install-time capability
  grants for file read, Git diff and evidence.
- jG consumes d2's grant and pre-approval rules; it builds only the
  install-time grants for its own adopted panes, which each plugin requests
  in its manifest and its lock entry lists.
- Legacy-id adoption: a fixed table maps each legacy id to the plugin that
  owns it (the table in
  [decision 2](#decision-2-everything-in-coding-moves-into-the-plugin)):
  the Coding file-browser and diff ids to Coding, the file-preview
  descriptor and `file-preview:` family to the file-preview plugin, and the
  PR review descriptor and `pr:` family to the PR review plugin. Instance ids
  and stateKeys are kept. Each mapping is honoured only for that plugin, and
  only with `kontour` provenance (pinned identity and lock entry).
- Instance families (`file-preview:`, `pr:`) are matched by parsing the
  instance id with the family's own parser (for example the
  `file-preview:<32 hex>` form), never by a string-prefix check. Today's
  core code dedupes previews with `id.startsWith('file-preview:')`; the
  adoption check must not copy that.
- The same grant mechanism serves jF (file read) and jP (pull-request data),
  so neither builds its own.
- **No terminal.** jG adopts no terminal id and adds no install-time
  terminal grant: `pane:builtin:coding:terminal` stays a presentation alias
  of the core `terminal` target, gated by the caller's own
  `terminal:operate` / `terminal:observe` ([terminal.md](terminal.md)).

Acceptance, with a fixture plugin signed by a test identity that a test
build pins and lists in a test lock (no dependence on j):

- Installed with the grants, the fixture plugin mounts panes under the
  adopted file-browser and diff ids, with their stored stateKeys.
- The same plugin installed without a grant gets that pane denied with its
  reason.
- Built-in provenance alone no longer grants anything.
- A plugin from another identity, or from the pinned identity but absent
  from the lock, declaring a legacy id is refused the adoption.
- A `kontour` plugin declaring a legacy id that the table maps to a
  different plugin is refused the adoption.
- A non-`kontour` plugin claiming `pane:builtin:workspace-preview:file-preview`,
  a `file-preview:` instance or a `pr:` instance is refused.
- An instance id that starts with `file-preview:` but does not parse as the
  family's form (for example `file-preview:../x`) is not adopted.
- A plugin declaring `pane:builtin:coding:terminal` is refused at install.

Proof: contracts and installer tests per rule, and a real-browser spec with
a grant withheld. Restoring the provenance check must fail the plugin-pane
test; removing the identity or lock condition must fail the spoofing test;
replacing the family parser with a prefix check must fail the malformed-id
test.

### jF. File preview → its own default plugin, with migration [security]

- The file-preview pane (`workspace-panes/FilePreviewPane.tsx` and its
  state storage) ships from station-plugins as its own plugin in the
  bundled set, built only on public packages. Its diff mode uses the SDK
  `DiffView`; its content uses `FileView`.
- Chat, Sessions, the navigation store, `useOpenInRegion` and Coding open it
  by descriptor through SDK-4. Nothing in core imports it.
- **The open handshake moves.** Today core's `openFilePreviewInRegion`
  (`src-ui/src/contexts/useOpenInRegion.ts`) writes
  `station:file-preview-pane-state:v1:<id>` before opening, rolls the write
  back when the region model refuses, and dedupes by scanning placed
  previews' stored state for the same project, path and thread. After jF:
  - the request travels as the open target's parameters through SDK-4
    (project, path, line range, thread), not as a pre-written record;
  - the plugin owns its state: it writes it when its pane mounts with those
    parameters, so a refused open writes nothing and needs no rollback;
  - dedupe is a declared key on the target (project, path, thread), so
    SDK-4 reveals an existing occurrence, and the plugin applies a newly
    requested line range on reveal;
  - the plugin reads its own state from SDK-6, not from a core
    `localStorage` key.
  How SDK-4 expresses the dedupe key is #3875's relation contract; jF does
  not define a second one.
- **Clipboard** (the copy action on file links and in the pane) uses SDK-1's
  `host.clipboard`.
- File read comes from a jG-style grant listed in its lock entry.
- **Coordination:** #3875 reworks file-preview relations. jF lands on that
  lane's relation contract and does not carry a second version of it.
- **Migration:** `pane:builtin:workspace-preview:file-preview` and the
  `file-preview:` instance family are adopted by this plugin (jG). The
  **host** performs a one-time import on the plugin's first activation: it
  copies every stored `station:file-preview-pane-state:v1:<id>` entry into
  the plugin's SDK-6 namespace under the same instance id, then deletes the
  old keys. The plugin never reads core's key.

Acceptance:

- A file link in chat opens the plugin's preview pane, with Coding
  uninstalled.
- A file-preview pane saved in a layout or dock before jF reopens with its
  stored state, read from the plugin's SDK-6 namespace after the import.
- A refused open leaves no state record; opening the same file twice reveals
  one pane and applies the second request's line range.
- Without the file-preview plugin, the open answers `unavailable`, and the
  link shows the path with a copy action.
- `src-ui` has no file-preview pane source left.

Proof: a real-browser spec opening a file link with Coding uninstalled; a
migration test from a stored layout and a stored preview-state entry in
today's exact shape; and a dependency scan paired with those specs.
Removing the adoption entry must fail the migration test.

### jP. PR review → its own default plugin, with migration [security]

- The PR review pane (`coding-layout/PullRequestReviewPanel.tsx` and the
  `pull-requests/` components it needs) ships as its own plugin in the
  bundled set, on SDK-views' PR review data hooks, SDK-1's
  `host.openExternal` and the kit.
- The dock's PR chips, the region `pr:` family and Coding open it by
  descriptor through SDK-4.
- Pull-request data comes from a jG-style grant listed in its lock entry.
- **Migration:** `pane:builtin:workspace-pull-request` and the `pr:`
  instance family are adopted by this plugin (jG).

Acceptance:

- A PR chip in chat opens the plugin's review pane, with Coding
  uninstalled.
- A PR review pane saved before jP reopens on the same pull request.
- Without the PR review plugin, the chip opens the pull request externally.

Proof: a real-browser spec from a PR chip with Coding uninstalled; a
migration test from a stored `pr:` placement in today's exact shape.
Removing the adoption entry must fail the migration test.

### j. Coding → plugin, with migration [security]

Marked **[security]** because it moves file and diff authority from
built-in provenance to grants (jG) and changes server admission (a2).
Terminal authority does not move: it stays with the caller's own terminal
grants (terminal.md).

- Coding ships from station-plugins using slice a's fields, built only on
  public packages: the SDK, `@kontourai/station-shared`,
  `@kontourai/station-contracts` and `@kontourai/ui`. It owns the Coding
  panes (file browser, diff, branch toolbar, pull-request list, the
  inspector composition, the terminal drawer's presentation) and opens file
  preview and PR review through their own plugins (jF, jP)
  ([decision 2](#decision-2-everything-in-coding-moves-into-the-plugin)).
- Core surfaces that used Coding panes switch to SDK views or open them by
  descriptor, per the decision 2 table.
- Delete every site in the
  [capability map's list](#coding-capability-map-condensed), restate the
  `BUILTIN_CODING_LAYOUT` promise, and retire or repoint
  `coding-composition-inventory-gate.mjs` and slice R.
- **Migration:** persisted project layouts with `type: 'coding'` and
  `source: 'builtin'` are read as the Coding plugin's layout, with their
  configuration preserved. The mapping is one explicit rule, not a remaining
  special case, and it binds only to a Coding plugin with `kontour`
  provenance (pinned identity and lock entry); no other plugin can claim
  those records. It is removed only after a recorded migration of stored
  records. With the plugin absent, such a layout renders `unavailable` with
  a reason and a reinstall action from the bundled set.
- The terminal inside Coding is the SDK `TerminalView` or the core closed
  `terminal` target (OPEN-12, answered: no interim). When j lands, the
  existing `CodingTerminalPane` is retired. #3894's boundary test and the
  one-time import of `coding-terminal-*` presentation state move into the
  Coding plugin as plugin-side work.

Acceptance:

- Slice a's parity spec passes with Coding installed as a plugin.
- A fixture replacement layout (a test plugin declaring `primary: 'chat'`,
  `presentation: 'stack'` and its own drill-ins) renders in Coding's place
  when the Coding plugin is disabled. The acme replacement stays i3's proof.
- A project with a stored `type: 'coding'` layout from today opens
  unchanged, including saved pane placements under the adopted ids, on a
  fresh install and on an upgraded Station (i0's upgrade path).
- A plugin from another identity declaring the Coding layout does not
  receive the stored `type: 'coding'` records.
- With the Coding plugin uninstalled, the surfaces named in decision 2
  degrade as stated there, and Tasks still renders diffs and files.

Proof: the parity spec; a migration test from today's stored layout shape; a
real-browser spec of the degraded surfaces; and two structural scans, paired
with the behavioral specs:

- no `type === 'coding'` (or the equivalents listed in the capability map)
  in `src-ui`, `src-server` or `packages/contracts`, and no
  `src-ui/src/components/coding-layout/` directory;
- in station-plugins, the Coding plugin imports nothing outside the public
  packages above.

### k. Home → plugin, with migration [security]

- Kontour's Home ships as the default filler of the Home slot through slice
  e's resolver.
- Overrides requesting elevated grants go through the existing Home-role
  consent channel.
- **Migration:** an existing `workspace-home-role.json` grant becomes a Home
  slot override with the same standing rules (`lapsed` on uninstall, version
  or byte change).

Acceptance:

- Uninstalling or breaking an override returns the root route to the default
  Home.
- An existing granted Home still mounts after the upgrade. A lapsed one
  still falls back.

Proof: a real-browser spec that breaks the override, and a migration test
from today's grant file shape.

### l. Inbox/Chat → plugin, approval decisions [security]

- Kontour's chat and inbox ship as default fillers of the chat and approval
  slots (OPEN-1). They are tier 2 by Kontour signature and hold
  `approvals.render` and `layout.primaryChat`.
- The server stays the only authority that decides an approval.
- Implement OPEN-11's chosen option. Under the proposal, high-risk approvals
  are re-confirmed on a kernel-owned channel outside the shell document.

Acceptance:

- A tier-3 plugin requesting `approvals.render` is refused.
- With the chat plugin overridden by a broken plugin, pending approvals
  still render through the default filler.
- Under the proposal: a high-risk approval sent only through
  `POST /tool-approval/:approvalId` with the session's authority is held until
  the kernel-channel confirmation arrives.
- A test demonstrates the disclosed limit: an ordinary approval carrying the
  session's authority is still accepted.

Proof: grant-refusal tests, a fallback spec with a broken override, and
server tests for both the held high-risk decision and the documented
ordinary-approval behavior.

### m. Plugin authoring

1. Docs catch-up: update build-your-first-plugin.md and plugins.md for the
   preview pane, proposals in Needs attention, and Publish to git.
2. One-click install from preview, still through the ordinary consent
   install.
3. Signing at publish: keyless Sigstore from the publisher's CI (OPEN-4),
   with the registry ed25519 path kept for registries that use keys.
4. Registry publish.

Acceptance:

- Preview's install action opens the same consent flow as the Plugins page
  and cannot skip it.
- A published package verifies against the publisher's signer (a Sigstore
  identity or a registry key) and installs with `publisher` provenance.

Proof: a route test that the preview install carries a consent decision, and
a publish-then-install test with signature verification. Parts 3 and 4 are
[security].
