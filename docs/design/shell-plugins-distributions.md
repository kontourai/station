# Shell kernel, plugin contributions and distribution manifests

> **Reading status: accepted direction, not built.** This record holds the
> owner decisions of 2026-09-29 and the delivery plan that implements them.
> Nothing below is shipped behavior unless the text says it **exists** and
> cites the source that establishes it. The "Current state" section was
> checked by source inspection against `origin/main` at `2e8ddc0f7` on
> 2026-09-29. No test was executed for this record. For current plugin
> installation and grants, read [plugins](../guides/plugins.md) and the
> [installation lifecycle](plugin-installation-lifecycle.md).

Status: **accepted direction** (owner decisions, 2026-09-29). This record
amends three earlier records without rewriting them:

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

## Current state (verified 2026-09-29, source inspection at `2e8ddc0f7`)

What each item below establishes is location and code shape, not executed
behavior.

**Layouts and Boards**

- `LayoutOwner` is `project | principal | instance`, derived only by
  `layoutOwner()` ([layout.ts](../../packages/contracts/src/layout.ts)). A
  Layout has no subject field.
- Boards exist:
  - The sidebar `+` creates an "Untitled Board" and enters rename. The section,
    and with it the `+`, renders nothing while no Board exists
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
  check. Since #2952, which was re-checked after merging it, the check is
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
| Project | project member holding `manage-extensions` (today: `owner`; see OPEN-5) | project layouts such as Coding |
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
  - An update with the same key, a new digest and no new capabilities keeps
    the tier and grants. Today's rebind already moves grants to the new
    digest.
  - An update signed by a different key is a new trust decision.
  - An update requesting any capability not previously granted re-prompts
    before its code activates. This closes "updates launder consent".
  - An unsigned plugin has no key, so every content change re-prompts.
- **Who is affected.** On a shared Station, trust and grant prompts list the
  scope of effect: all members and all paired devices, because in-process
  code runs on every device that renders it.
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
| Policy | Telemetry default | exists (`AppConfig.telemetryEnabled`) | [usage-telemetry-service.ts](../../src-server/services/usage-telemetry-service.ts) |
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

- `plugins/<name>/`: one package each, released independently and signed with
  Kontour's key;
- `distributions/kontour-default/`: the default manifest;
- the `acme-distribution` example, in that repository's examples folder: extends kontour-default, swaps the Coding
  layout and Home, and sets branding and SSO configuration;
- `templates/plugin-starter/`.

Station's CI installs pinned released versions, never workspace sources. The
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
- **OPEN-4. Kontour key custody.** "Kontour-signed" needs a shipped anchor key,
  a rotation rule and a revocation path. Today's anchors are per-registry
  operator configuration. The relationship to ADR 0020's split updater keys
  is undecided. Release signing for station-plugins lands wherever this is
  decided.
- **OPEN-5. Who installs project layouts.** The owner said "admin or
  operator", but `manage-extensions` belongs only to `owner` today.
  *Proposed:* add a project-scoped "manage layouts" permission for project
  admins; instance installs stay owner-only.
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

  *This record's proposal* is (b), with (d)'s disclosure in every raise
  prompt. It is not an owner decision.

## Delivery plan

Each slice is one pull request unless noted. **[security]** marks a slice
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
| a. Layout contract fields and generic host | — | |
| b. Owner × subject | — | [security] |
| c. Board UX | b (for save-as) | |
| d1. Trust records, key and digest pinning, migration | #1521 | [security] |
| d2. Per-plugin capabilities, high-risk class, update re-prompt | d1 | [security] |
| d3. Raise on the consent listener; retire the remote-bundle store | d1 | [security] |
| d4. Cross-origin nonce fix | — | [security] |
| e. Required-slot resolver | — | [security] |
| f. Safe mode | e | [security] |
| g. Distribution manifest, precedence, reset | d1, OPEN-4 | [security] |
| h. Distribution branding and defaults | g | [security] |
| i1. station-plugins repo scaffold and starter template | — | |
| i2. Board extraction as an installed plugin, with migration | d1, i1 | [security] |
| i3. kontour-default and acme manifests | g, h, i2, OPEN-4 | [security] |
| j. Coding → plugin, with migration | a, i2 | |
| k. Home → plugin, with migration | e, i2 | [security] |
| l. Inbox/Chat → plugin, approval decisions | a, d2, e, j, OPEN-11 | [security] |
| m. Plugin authoring | docs part: —; signing and registry: d1, OPEN-4 | [security] (signing) |

Browser and Device panes follow i2's pattern as their own slices.

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

### b. Owner × subject [security]

- Add a `subject` contract field with one derivation function.
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

### d1. Trust records, key and digest pinning, migration [security]

- Add the install trust record, with provenance from verified signatures.
  This depends on #1521 consuming verified claims, and on OPEN-4 for what
  "Kontour-signed" verifies against.
- Pin to key plus digest.
- **Migration:** every plugin installed before d1 gets a grandfathered record
  at its current effective tier, marked `grandfathered`, with its current
  digest and the tier it runs at today. The plugin manager surfaces
  grandfathered records for an explicit operator decision. Nothing drops to
  tier 3 silently, and no existing pane mounts `unavailable` because of d1.

Acceptance:

- A new unsigned install records tier 3.
- A new Kontour-signed install records tier 2.
- A changed digest on the same key keeps the tier.
- A different key produces a new, untrusted decision.
- A Station upgraded with an in-process plugin already installed still
  mounts that plugin in-process, and lists it as grandfathered.

Proof: installer unit tests per rule, and a migration test that starts from
today's installation and grant files (exact writer shape) and asserts the
pane still selects `trusted-plugin-react`.

### d2. Per-plugin capabilities, high-risk class, update re-prompt [security]

- The host offers renderer capabilities per plugin from its trust record,
  replacing the client-wide frames flag.
- The high-risk grant class, enforceable for tier-3 and server-side
  contributions. For tier 2 it gates the raise only.
- An update requesting any new capability does not activate until consent
  is given.

Acceptance:

- A tier-3 plugin cannot select `trusted-plugin-react`.
- An update adding `agents.invoke` stays inactive until consent is given.
- A tier-3 plugin requesting `approvals.render` is refused.

Proof: frame-mount and installer tests, each failing when its rule is
reverted.

### d3. Raise on the consent listener; retire the remote-bundle store [security]

- Raising a plugin to tier 2, and any high-risk grant, is decided only on the
  distinct-origin consent listener.
- The prompt uses the exact tier-2 disclosure wording from
  [tier 2 is the kernel's own realm](#tier-2-is-the-kernels-own-realm) and
  lists who is affected.
- Retire `remotePluginBundlesAllowed`: remote-Station bundles run at tier 3
  on the device.
- **Migration:** a device that had admitted a remote Station's bundles sees
  them in frames, or `unavailable` with a reason, and is told why once.

Acceptance:

- A raise sent to an ordinary authenticated route is refused.
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

- One resolver for the required slots (OPEN-1). It is derived on every read
  from the live installation.
- Overrides can be added and removed. The default filler can be neither
  uninstalled nor disabled.
- It returns the safe-mode signal only when the default filler fails.

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
- Automatic entry when no working layout resolves or a default filler fails.
- It loads no plugin browser code.
- Add its path to the reserved plugin identities.

Acceptance:

- With every plugin, default fillers included, failing to load, Station
  boots into safe mode showing the plugin manager.
- In safe mode, no plugin bundle request is made.
- An operator can disable a plugin and leave.
- A plugin claiming the safe-mode path is refused at install.

Proof: a real-browser spec with a broken plugin set, asserting both the
rendered surface and zero bundle requests. Removing the automatic entry must
fail it.

### g. Distribution manifest, precedence and reset [security]

- Add the `distribution` contribution kind:
  - plugins with pins and keys;
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
- A manifest pinning a key that does not match the fetched plugin is refused
  before any tree write.
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

### i1. station-plugins repo scaffold and starter template

- Create `kontourai/station-plugins` with `plugins/`, `distributions/`,
  `examples/` and `templates/plugin-starter`, plus its CI.

Acceptance:

- The starter template builds and installs into a test Station through the
  ordinary consent install.

Proof: the repo's CI builds the starter, and a Station e2e test installs it.

### i2. Board extraction as an installed plugin, with migration [security]

- Move `board-pane` to station-plugins; `src-ui` no longer imports it.
- Station CI installs a pinned released version.
- **Migration:** D2 fails closed on plugin panes. Existing Boards, project
  layouts and dock placements that reference the Board pane keep rendering:
  the extracted Board plugin gets a grandfathered visibility grant for every
  principal who could see the built-in, and the pane id is preserved or
  mapped once.

Acceptance:

- A fresh Station renders the Console Board through the installer.
- `src-ui` has no dependency on the board package.
- A Station upgraded with a personal Board holding the Board pane still
  renders it for its owner.
- CI fails when the pinned release is missing.

Proof:
- a dependency scan (structural, paired with the behavioral tests);
- an end-to-end install from the pinned release;
- a migration test from a Board record in today's exact shape.

### i3. kontour-default and acme manifests [security]

- Publish `distributions/kontour-default` and the `acme-distribution` example.
- Release signing uses whatever OPEN-4 decides.

Acceptance:

- A fresh Station installing kontour-default matches today's default
  experience.
- acme extends it, swaps the Coding layout and Home, and sets branding and
  SSO configuration.
- A tampered artifact fails verification in CI.

Proof: e2e install of both manifests, and a CI run against a tampered
artifact.

### j. Coding → plugin, with migration

- Coding ships from station-plugins using slice a's fields.
- Delete every `type === 'coding'` site.
- **Migration:** persisted project layouts with `type: 'coding'` are read
  as the Coding plugin's layout, with their configuration preserved. The
  mapping is one explicit rule, not a remaining special case, and it is
  removed only after a recorded migration of stored records.

Acceptance:

- Slice a's parity spec passes with Coding installed as a plugin.
- The acme replacement Coding layout renders in its place.
- A project with a stored `type: 'coding'` layout from today opens unchanged.

Proof: the parity spec; a migration test from today's stored layout shape;
a scan asserting no `type === 'coding'` in `src-ui` (structural, paired with
the behavioral spec).

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
3. Signing at publish, per OPEN-4.
4. Registry publish.

Acceptance:

- Preview's install action opens the same consent flow as the Plugins page
  and cannot skip it.
- A published package verifies against the publisher key and installs with
  publisher-signed provenance.

Proof: a route test that the preview install carries a consent decision, and
a publish-then-install test with signature verification. Parts 3 and 4 are
[security].
