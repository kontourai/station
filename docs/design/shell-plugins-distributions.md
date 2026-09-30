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
   - `examples/acme-distribution`, which extends the default, swaps the
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

**Branding, sign-in and defaults**

- A plugin `branding` provider supplies app name, logo, theme and welcome
  message ([provider-interfaces.ts](../../src-server/providers/provider-interfaces.ts),
  [`/api/branding`](../../src-server/routes/system/branding.ts)).
- The white-label theme applies five role tokens and refuses the whole theme
  (keeping defaults) on an unknown key, a non-hex value or a failed contrast
  check ([branding-theme.ts](../../src-ui/src/lib/branding-theme.ts);
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

- **Defaults.** Kontour-signed starts at tier 2 and unsigned at tier 3.
  Publisher-signed starts at tier 3 until the operator raises it (see OPEN-3).
  Lowering is always allowed. Raising an unsigned plugin shows an explicit
  warning.
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
- **High-risk grants** require a tier-2 install. Illustrative names (see
  OPEN-7): `approvals.render` (fill the approval slot) and `layout.primaryChat`
  (be a layout's `primary: 'chat'` renderer). The consent copy names the grant
  and who is affected.
- **Who is affected.** On a shared Station, trust and grant prompts list the
  scope of effect: all members and all paired devices, because in-process
  code runs on every device that renders it.

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
   - The design rules in the `@kontourai/ui` DESIGN.md are not shipped in the
     installed package (1.12.0), so this record cites the package README and
     token ADR instead (OPEN-10).

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
- `examples/acme-distribution/`: extends kontour-default, swaps the Coding
  layout and Home, and sets branding and SSO configuration;
- `templates/plugin-starter/`.

Station's CI installs pinned released versions, never workspace sources. The
repository is public, so its fixtures use generic names and hosts.

## Threat notes: what operator discretion cannot cover

- **Consent cannot attest a person.** Any caller holding a Station credential
  can preview and install, including an agent with a shell tool
  ([authority model](plugin-authority-model.md#where-consent-belongs)). A
  trust *raise* or a high-risk grant must therefore be decided on the
  distinct-origin consent listener, like the Home role, not on an ordinary
  authenticated route. Otherwise "the operator raised it" is not a fact.
- **Tier 2 plugins are not isolated from each other.** Every bundle's shim
  assigns `globalThis.require`, so the first in-process plugin loaded controls
  module resolution for the rest. Trusting one unsigned plugin at tier 2
  therefore extends to every tier-2 plugin, Kontour's approval renderer
  included. Tier 2 is one realm (OPEN-2).
- **Digest pinning covers bytes on disk, not code fetched at runtime.**
  [`plugin-content-integrity.ts`](../../src-server/services/plugins/plugin-content-integrity.ts)
  states this limit. The remaining nonce assignment on the cross-origin inline
  path is how in-process code mints undeclared scripts. The tier-3 frame
  receives no nonce, so the owner's "fix the nonce before claiming sandboxed"
  is discharged for frames. It still gates any claim that a tier-2 pin bounds
  what runs.
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
  - Open question 2 is answered: install consent defaults to full trust only
    for Kontour-signed plugins, per install, and the operator can lower it.
  - "Updates launder consent" is addressed by re-prompting on new
    capabilities and a new key.
  - Its per-contribution question (1) keeps its answer: panes are confinable,
    `serverModule` only disclosable.
- **[shell-ownership-and-boards.md](shell-ownership-and-boards.md)**
  - D1 gains the subject axis, clone, templates and project policy. D2 stands
    and gains a personal hide/disable layer.
  - Its open question "Should Home become the viewer's default Board?" is
    replaced by the Home slot.
  - Its non-goal "No new plugin contribution types" is lifted for the
    `distribution` contribution and the layout contract fields.

## Open items

- **OPEN-1. Exact slot set.** Home and the approval surface are slots. Is the
  primary chat surface one slot with approvals, or two? A split lets a
  third-party chat exist without approval-render authority.
- **OPEN-2. Plugin-to-plugin isolation at tier 2.** The shared
  `globalThis.require` shim means operator trust in one tier-2 plugin is trust
  in all of them. Should a raised unsigned plugin share a realm with the
  approval-slot filler, or must high-risk slot fillers load before, and apart
  from, operator-raised code? Evidence: [build.ts](../../packages/shared/src/build.ts),
  [authority model](plugin-authority-model.md#a-threat-no-disclosure-can-express).
- **OPEN-3. Publisher-signed default.** The owner fixed defaults for
  Kontour-signed and unsigned only. This record proposes tier 3 for
  publisher-signed until raised, because `keyId` is a label, not a verified
  publisher identity ([registry-trust-policy.md](registry-trust-policy.md)).
- **OPEN-4. Kontour key custody.** "Kontour-signed" needs a shipped anchor key,
  a rotation rule and a revocation path. Today's anchors are per-registry
  operator configuration. The relationship to ADR 0020's split updater keys
  is undecided.
- **OPEN-5. Who installs project layouts.** The owner said "admin or
  operator", but `manage-extensions` belongs only to `owner` today. Widening
  it to `admin` is a membership change with its own review.
- **OPEN-6. Sign-in in a manifest.** A manifest may configure the kernel's
  OIDC adapter. Selecting an authentication *module*
  (`STATION_AUTHENTICATION_MODULE`) loads code into the kernel's sign-in
  path. This record keeps module selection an operator deployment choice
  outside manifests, pending owner confirmation.
- **OPEN-7. Grant names and vocabulary.** `approvals.render` and
  `layout.primaryChat` are illustrative. The typed permission vocabulary
  (archive#3534) may own them.
- **OPEN-8. Instance-shared Boards role.** Carried from
  shell-ownership-and-boards: is operator-only authorship enough?
- **OPEN-9. Member disable of a slot filler.** May a member hide an
  operator-overridden Home and see the default filler instead? This record
  assumes yes, as a personal preference.
- **OPEN-10. Brand rule source.** The `@kontourai/ui` DESIGN.md rules could not
  be verified from the installed package. The validator comment points at a
  later `@kontourai/ui/contrast` module (1.16.0) that Station does not yet use.

## Delivery plan

Each slice is one pull request unless noted. **[security]** marks a slice
that touches a security boundary and needs an independent security review
before merge. Every named test must fail when the slice's behavior is
reverted; each slice records that fault injection in its pull request.

| Slice | Depends on | Security |
| --- | --- | --- |
| a. Layout contract fields and generic host | — | |
| b. Owner × subject | — | [security] |
| c. Board UX | b (for save-as) | |
| d. Trust model and CSP nonce | — | [security] |
| e. Safe mode | — | [security] |
| f. Distribution manifest, precedence, reset | d | [security] |
| l. Distribution branding and defaults | f | [security] |
| g. station-plugins repo, Board extraction, manifests | d, f, l | [security] |
| h. Coding → plugin | a, g | |
| i. Home → plugin (slot) | g, required-slot resolver from e or its own sub-slice | [security] |
| j. Inbox/Chat → plugin | a, d, h, i's slot resolver | [security] |
| k. Plugin authoring catch-up | docs part: —; signing and registry: d | [security] (signing) |

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

### b. Owner × subject

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

Proof: server route tests with two authenticated principals. Removing the
subject check or the policy check must fail them.

### c. Board UX

- The Boards section header and `+` are always visible, including with zero
  Boards.
- Add or arrange panes on a Board, from the D2-visible set, via the existing
  `PUT /api/me/layouts/:slug`.
- Reorder Boards.
- "Save as my layout" (from slice b).
- Instance-shared Boards: operator-only route and UI, listed after personal
  Boards and marked shared.

Acceptance:

- A new user with zero Boards sees the `+`.
- Adding a pane persists across reload and a second device.
- Reorder persists.
- A non-operator cannot create or edit an instance Board (403). A member
  sees it as read-only.

Proof: a real-browser spec for the first-Board path and add-pane, and route
tests for instance-Board authority. Hiding the `+` again must fail the first.

### d. Trust model and CSP nonce [security]

- Install trust records pinned to key plus digest, with provenance
  classification from verified signatures (building on #1521).
- Per-plugin capability offering, mapping tier to renderer capabilities.
- Update re-prompt on a new capability or a different key.
- The high-risk grant class.
- Trust raises decided on the distinct-origin consent listener.
- Remove the nonce assignment from the cross-origin inline bundle path, by
  serving the bundle by URL or refusing it.

Acceptance:

- An unsigned plugin installs at tier 3 and its pane mounts in a frame.
- The same plugin raised by the operator mounts in-process. A raise attempted
  through an ordinary authenticated route is refused.
- An update adding `agents.invoke` does not activate until consent is given.
- An update signed by another key lands untrusted.
- No bundle script element carries the shell nonce on any path.

Proof:
- installer and route tests for each rule;
- a CSP test asserting no plugin script receives a nonce, including the
  cross-origin path;
- a frame-mount test proving tier 3 cannot select `trusted-plugin-react`.

Each must fail when its rule is reverted.

### e. Safe mode [security]

- Kernel boot state with explicit entry: a CLI flag, a Settings action and a
  reserved URL.
- Automatic entry when no slot or working layout resolves.
- It loads no plugin browser code.
- Add its path to the reserved plugin identities.

Acceptance:

- With every plugin failing to load, Station boots into safe mode showing the
  plugin manager.
- In safe mode, no plugin bundle request is made.
- An operator can disable a plugin and leave.
- A plugin claiming the safe-mode path is refused at install.

Proof: a real-browser spec with a broken plugin set, asserting both the
rendered surface and zero bundle requests. Removing the automatic entry must
fail it.

### f. Distribution manifest, precedence and reset [security]

- Add the `distribution` contribution kind: plugins with pins and keys,
  extends/replaces, a policy section that produces a `DistributionProfile`,
  and trust proposals shown item by item at install.
- Three-layer precedence.
- "Reset to distribution defaults".
- Install at first run, later, or from configuration.

Acceptance:

- A child manifest's override beats its parent.
- An operator's local lifecycle choice beats both, and survives reinstalling
  the manifest.
- Reset clears local choices for the chosen sections and leaves trust
  records unchanged.
- A manifest pinning a key that does not match the fetched plugin is refused
  before any tree write.

Proof: installer and precedence unit tests, plus one route test with a
mismatched key.

### l. Distribution branding and defaults [security]

- Manifest sections for brand, setup and defaults, grounded on the existing
  `branding` provider, the theme validator, the OIDC configuration file and
  the profile service.
- New hooks for favicon, title, onboarding copy, empty states, help links and
  legal links.
- A fixed kernel-prompt frame with a provenance line.

Acceptance:

- The acme example changes the product name, logo, favicon, theme tokens and
  onboarding copy.
- Kernel prompts rendered under acme branding (consent, approval, sign-in
  recovery, safe mode) keep the Station frame, show "acme-distribution by
  <publisher>", and accept only tint.
- A low-contrast token set is refused as a whole and the defaults stay.

Proof:
- a real-browser spec with screenshots reviewed for the acme case and the
  kernel frames;
- a unit test that feeds a low-contrast set and asserts refusal;
- a test that an acme theme cannot remove the provenance line.

### g. station-plugins repo, Board extraction and manifests [security]

- Scaffold `kontourai/station-plugins` with its release and signing
  workflow.
- Move `board-pane` there as an installed plugin; `src-ui` no longer imports
  it.
- Publish `kontour-default` and `examples/acme-distribution`.
- Station CI installs pinned released versions.

Acceptance:

- A fresh Station with kontour-default renders the Console Board through the
  installer, not a compiled import.
- `src-ui` has no dependency on the board package.
- CI fails when the pinned Board release is missing or its signature does
  not verify.

Proof:
- a dependency scan asserting no `@kontourai/station-board-pane` import in
  `src-ui`;
- an end-to-end spec installing from the pinned release;
- a CI job run against a deliberately tampered artifact.

Browser and Device panes follow as sub-slices of g.

### h. Coding → plugin

- Coding ships from station-plugins using slice a's fields.
- Delete every `type === 'coding'` site.

Acceptance:

- Slice a's parity spec passes with Coding installed as a plugin.
- The acme example's replacement Coding layout renders in its place.

Proof: the parity spec, plus a scan asserting no `type === 'coding'` in
`src-ui` (a structural rule, paired with the behavioral spec).

### i. Home → plugin (required slot) [security]

- Add the required-slot resolver, built here if slice e has not landed.
- Kontour's Home ships as the default filler: bundled with the default set,
  not uninstallable, overridable.
- Overrides requesting elevated grants go through the existing Home-role
  consent channel.

Acceptance:

- Uninstalling or breaking an override returns the root route to the default
  Home.
- Uninstalling the default filler is refused.
- "No Home" cannot be expressed in any configuration.

Proof: resolver unit tests over the live installation and a real-browser
spec that breaks the override. A resolver that returns an empty slot must
fail them.

### j. Inbox/Chat → plugin, with approval-render grants [security]

- Kontour's chat and inbox ship as the default filler of the chat and
  approval slot (or slots; OPEN-1), holding `approvals.render` and
  `layout.primaryChat` through a tier-2 install.
- The server remains the only authority that decides an approval.

Acceptance:

- A tier-3 plugin requesting `approvals.render` is refused.
- With the chat plugin overridden by a broken plugin, pending approvals
  still render through the default filler.
- An approval decision made from a plugin surface is re-validated server
  side.

Proof: grant refusal tests, a fallback spec with a broken override, and a
server test that a forged decision is refused.

### k. Plugin authoring

1. Docs catch-up: update build-your-first-plugin.md and plugins.md for the
   preview pane, proposals in Needs attention, and Publish to git.
2. One-click install from preview, still through the ordinary consent
   install.
3. Signing at publish.
4. Registry publish.

Acceptance:

- Preview's install action opens the same consent flow as the Plugins page
  and cannot skip it.
- A published package verifies against the publisher key and installs as
  publisher-signed.

Proof: a route test that the preview install carries a consent decision; a
publish-then-install test with signature verification. Parts 3 and 4 are
[security].
