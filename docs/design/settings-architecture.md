# Settings Architecture: scope-first settings for Station

Status: incremental implementation (2026-07-30). Research base: comparative review of four reference
agent-tooling products' settings systems (attributed analysis lives in the private
ops workspace, per this repo's no-competitor-names policy), plus a full audit of
Station's current settings surface at `73381430`. Companion backlog: archive#572 (navigation grouping),
archive#536 (agent-oriented hierarchy), archive#175 (CLI config divergence), archive#983 (config watcher
has no subscriber), archive#802 (layout removal discoverability).

The first visible increment shipped through archive#1354: `/settings` explains the
Station, Defaults, and This-device scopes up front; provider, developer-service,
and computer setup has one canonical home in Connections; host detection is
clearly labeled as describing the Station host; Agent defaults remain behind
progressive disclosure; and keyboard shortcuts use the versioned device-settings
record. Slice 3 (epic archive#1269) then shipped the full scope-driven section rewrite
described below: `/settings` is now three registry-driven scope sections
(Station / Defaults / This device) with a persistence-tier caption each; the
previously hidden Station fields (`approvalGuardian`, `defaultMaxTurns`,
`defaultMaxOutputTokens`, `terminalShell`, `mcpUiHost`,
`surfaceTrustFromVeritasEvidence`, `knowledgeStores`,
`disableDefaultSkillRegistries`, `registryUrl`, `distributionProfile`,
`builtinAgentEngineConnectionId`) are surfaced with provenance badges; search is
registry-driven; and archive#1359's parallel `station.device-settings` root
(keyboard-shortcut and model-picker preferences) converged onto the slice-2
device-settings envelope. Slice 4 (archive#1273) then closed the chat-settings gap
the original audit found: ChatSettingsPanel's reasoning/tool-details/font
prefs move to the device-settings store and dock mode gains a device-scope
fallback (§3 S4), and the save-model convention this design implied is now
written down (§4.1) and audited against every existing surface. Remaining
longer-term architecture: the naming/cross-links slice (#5) and the
plumbing-debt slice (#6).

## 1. The problem

Station's settings grew page-by-page, not model-first. The audit found:

- **One "Settings" page with mixed ownership.** `/settings` interleaves controls for
  the Station server (log level, updates, diagnostics), the browser device (theme,
  accent, voice providers), agent-default fallbacks, and a personal knowledge store —
  four different lifecycles behind one nav.
- **Config with no UI.** `AppConfig` carries actively-consumed fields no screen can
  edit: `approvalGuardian`, `defaultMaxTurns`, `defaultMaxOutputTokens`,
  `terminalShell`, `surfaceTrustFromVeritasEvidence`, `mcpUiHost`,
  `disableDefaultSkillRegistries`, `distributionProfile`, `registryUrl`, and more.
- **UI with no persistence.** ChatSettingsPanel's Show Reasoning / Show Tool Details
  reset on every reload; chat font size survives only in a URL param; dock mode has
  no localStorage fallback while its sibling toggles do.
- **~25 scattered localStorage keys** with no schema, no versioning, and an
  Export/Import feature that covers exactly 4 of them.
- **Same word, different things.** "Knowledge" names three unrelated scopes
  (personal store, per-project store, vector-DB infra) with zero cross-navigation.
  "Notifications" names both a push toggle and an inbox page.
- **No provenance.** `region` can be set globally, per-agent, and by `AWS_REGION`;
  `managedChatOrchestration` is an env flag that appears inside `AppConfig` as if
  editable. The UI cannot tell the user which source wins.
- **Weak write path.** `PUT /config/app` validates as `z.record(z.unknown())` at the
  route boundary (AJV catches problems late); `station config set` bypasses the live
  route entirely (archive#175); the config watcher's agent/integration events reach no
  subscriber (archive#983).

## 2. What the reference products taught us

Patterns adopted from the comparative review (four reference agent-tooling
products; attributed per-product analysis lives in the private ops workspace):

- **Per-field provenance** — the settings API tells clients where each value came
  from (file / env / default), so a surface can name the source instead of
  guessing. (archive#1557: it reports the resolution that happens, never a
  prediction that an edit will be ignored.)
- **One typed write path shared by every client** — UI, CLI, and tools mutate
  settings through the same validated route; no client writes the file directly.
- **Unknown-key diagnostics instead of silent drops** — a stray or misspelled key
  is reported precisely, never silently absorbed.
- **Scope-split stores** — device-local client settings vs server-scoped instance
  settings vs per-entity config, each with its own schema and persistence, never
  merged into one blob.
- **Declarative setting registry** — one definition per setting (schema, default,
  scope, description, secret) with build-time invariants and completeness tests;
  dictionary-of-overrides for entity-scoped values.
- **Persistence-tier transparency** — each screen says where its settings live
  ("saved to this device" vs a save-toast for server writes); contextual settings
  live with their entity, not in the global page.

Deliberately skipped: multi-layer file-precedence stacks and org-policy
constraint engines (Station has no org-policy tier yet); settings-sync services
and encrypted account blobs (Station settings are server-authoritative per
instance); per-setting analytics metadata; duplicated page-vs-modal settings
implementations (observed in the wild as an explicit anti-pattern).

The consensus across all four products, independently arrived at: **settings are
organized by scope — who or what a setting controls and where it lives — not by
whichever page first needed them.** That is also exactly what archive#572 and archive#536 ask
for.

## 3. Target model: five scopes

Every setting is declared with exactly one scope. The scope determines storage,
write path, and which surface renders it.

### S1. Station — controls for this Station instance (server/host)
The revamped, focused "Station settings" the product needs. Everything here
configures the running server, not the person looking at it:
log level, update channel/check, build provenance, host runtime status, diagnostics
bundle, distribution profile, registry URL, terminal shell, MCP UI host, approval
guardian, `defaultMaxTurns` / `defaultMaxOutputTokens`, trust-surface flag,
feature flags (env-derived ones shown **read-only with provenance**, e.g.
`managedChatOrchestration` → "set by operator: STATION_FEATURES").
Storage: `<STATION_HOME>/config/app.json`, typed contract at the route
boundary. One instance = one settings document; every client sees the same values.

### S2. Defaults — workspace-wide fallbacks that entities override
Default model, default region, default system prompt, template variables — the
current "Agent defaults" section, kept distinct from S1 because these are not
controls *for Station*; they are the bottom of an override chain
(default → project → agent → per-invocation `modelOptions`). Each field renders
with its **effective-value chain** so the region trap (global vs agent vs
`AWS_REGION`) becomes visible instead of silent.

### S3. Device — this browser/client
Theme, accent color, chat font size, voice STT/TTS providers, feature toggles
(voice pill, TTS readback, mobile pairing, push), dock/layout geometry, chat
display prefs (show reasoning, show tool details, auto-hide), known-environments
registry, saved connections. Today: ~25 ad-hoc localStorage keys. Target: **one
versioned, schema-validated client-settings store** (single key, explicit
migrations from every legacy key, hydration-tracked so UI can distinguish
"loading" from "default"). Never round-trips to the server. Screens say so
("Saved to this device") — the persistence-transparency pattern from §2.

### S4. Entity — settings live with the thing they configure
Already mostly right; the revamp names it as a rule rather than an accident:
- **Project** → `/projects/:slug/edit` (workspace dir, project model, agent
  availability, project knowledge, layouts).
- **Agent** → agent editor (engine, model, thinking/effort defaults, guardrails,
  region override, prompt/skills/tools/commands).
- **Connection / engine / plugin / integration** → their own detail panels.
- **Chat/session** → ChatSettingsPanel, re-founded (build slice 4, archive#1273,
  shipped): display prefs (reasoning/tool details/font) are S3 device
  settings with an explicit per-session URL-param override; dock mode has a
  device-scope fallback.
Entity screens keep their homes; the global page never absorbs them. Cross-links
replace duplication (e.g. Defaults page links to "override per agent").

### S5. Connections — integration-shaped config stays in the hub
Models, engines, stations/environments (incl. the still-CLI-only peer credentials,
which get their UI home under Connections → Stations), knowledge infrastructure,
tool servers. The hub is close to right already; the revamp only renames the three
"Knowledge" surfaces distinctly (e.g. "My knowledge store" / "Project knowledge" /
"Knowledge infrastructure") and cross-links them.

## 4. Mechanism: the settings registry

One declarative registry (the §2 registry pattern, adapted) is the single source of truth:

```ts
defineSetting({
  key: 'logLevel',
  scope: 'station',            // station | defaults | device | (entity scopes stay in their own contracts)
  schema: z.enum(['debug', 'info', 'warn', 'error']),
  default: 'info',
  label: 'Log level',
  description: '…',
  envFallback: 'STATION_LOG_LEVEL',   // optional: env var consulted when nothing is stored
  secret: false,
})
```

Derived from the registry, so they can never drift:
- the typed `PUT /config/app` request schema (replacing `z.record(z.unknown())`),
- defaults (no parallel defaults object),
- the Settings UI rows for scalar settings (form-from-schema;
  composite editors like the guardian config opt out with a custom component),
- Export/Import coverage (export what the registry declares, honestly, both scopes),
- settings search terms (replacing the drifted hardcoded keyword map),
- registry-completeness tests: every `AppConfig` field is either registered or
  explicitly listed as `internal` (e.g. `managedChatOrchestration`), every device
  setting is either registered or explicitly grandfathered — CI fails on drift.

Write path: **all writers go through the live route** — UI, and `station config
set` when a Station is reachable (falling back to direct file write only with an
explicit `--offline` flag), closing archive#175. `GET /config/app` gains per-field
provenance (`default | file | env`) so the UI can name where a value came from
(the §2 provenance pattern).

**Corrected by archive#1557.** This originally said the UI would render
"overridden by operator env" badges "instead of accepting doomed edits", and
the badge shipped that way: an active `envOverride` var disabled the control
and labelled the stored value inert. No resolver in Station behaved that way.
`region` — the mechanism's only instance — resolves
`agentSpec.region -> config.region -> AWS_REGION -> us-east-1`
(`src-server/providers/llm/bedrock-region.ts`), so the "doomed" edit was the
one that actually applied, and Station greyed out the live value. The
declaration is now `envFallback` and provenance reports where the value comes
from: a stored value is `file` whatever the environment holds, and an absent
one whose declared fallback var is set is `env`, naming the var. A future
setting whose environment genuinely wins needs a resolver that does that
first; provenance reports resolution, it does not define it.

### 4.1 Save-model convention (station#settings-revamp slice 4)

One rule, everywhere a setting is edited:

- **Immediate-save with visible feedback** is the default. A single control
  (a toggle, a select, a stepper) writes and persists on change, with the
  persistence-tier caption ("Saved to this device", "Saved to this Station")
  as the feedback — there is no separate Save action to forget to press, and
  nothing to lose by navigating away. Every S3 device-scope control already
  followed this (`ThemeToggle`, `AccentColorPicker`, `VoiceFeaturesSection`'s
  provider pickers and feature toggles, `KeyboardShortcutsSection`,
  `DiffPanel`'s `diffStyle`/`diffWrap`, the inbox/sidebar/onboarding toggles,
  model-picker preferences); slice 4 brings ChatSettingsPanel's reasoning /
  tool-details / font-size / dock-mode controls onto the same rule (§3 S4,
  §6 slice 4) — the one place a single control still reset on reload instead
  of saving immediately.
- **Batched Save/Discard is reserved for multi-field forms that compose one
  server-side document written by a single request**, where saving one field
  mid-edit would leave the document in a state the user did not intend. The
  live instance is `/settings`'s Station (S1) + Defaults (S2) draft
  (`SettingsView.tsx`'s `config`/`hasChanges`/`useUnsavedGuard`, one `PUT
  /config/app`); entity editors (agent/project/skill) follow the
  same rule for their own multi-field server documents. This never applies
  to S3 device settings — nothing in that scope round-trips to the server —
  or to a single S1/S2 field edited in isolation.
- Rule of thumb when adding a new setting: if the write is one field with no
  cross-field validation dependency, save immediately; if committing that one
  field mid-edit could leave a larger document half-intended, batch it behind
  Save/Discard.

**Audit (slice 4).** Every existing single-control setting across `/settings`
and the chat dock already followed immediate-save; ChatSettingsPanel's
reasoning/tool-details/font-size were the one gap (no persistence at all,
fixed this slice) and dock mode's device-scope fallback was the other
(§3 S4). No control was found using batched Save/Discard for a single field —
the one batched form in the app (`SettingsView.tsx`'s Station+Defaults draft)
is correctly scoped to a genuine multi-field server document, and stays
out of this slice's scope (it is not chat/device-scoped, and restructuring
it is not warranted by anything this slice found).

## 5. Navigation

archive#2680 adds one flat UI catalog at
`src-ui/src/views/settings/settings-catalog.ts`. Each rendered control target
spreads `settingsRow(id)`, so its visible title, stable row anchor, search
entry, and `data-catalog-id` completeness marker share one declaration.
Composite and dynamically-sized controls (shortcuts, provider contexts,
shares, host status, and personal knowledge) use one cataloged parent target;
the mobile-only haptics target is explicitly conditional. Section labels and
navigation also derive from this catalog module. Links may address a control
with `?view=<section>&highlight=<row-id>`; the page scrolls and focuses it,
pulses once (with a non-animated reduced-motion treatment), then removes only
the consumed `highlight` parameter.

archive#4138 projects that same typed target inventory into the command palette
rather than creating a second command list or searching rendered DOM text.
Each command has a stable identity, section, and truthful write authority;
temporarily unavailable targets remain explanatory rows and do not masquerade
as executable navigation. The settings-local command copy and target labels are
localized only when the lazy settings projection is used, while its English
keywords remain stable search inputs. This uses the shared placeholder formatter
so locale expansion never changes the command identity or search vocabulary.

The canonical deep link is `/settings?view=<owner>&highlight=<target>`. A cold
or malformed link is normalized with replacement; an in-app palette selection
pushes a history entry. A reveal opens the owning disclosure if necessary and
focuses the declared safe row/control, not an arbitrary button. It cancels when
superseded or when the person has intentionally focused elsewhere, so it does
not compete with palette return focus. Navigating within mounted Settings keeps
the form and its drafts alive; only a genuine route leave crosses the existing
unsaved-changes guard, so Back retains the expected Settings intent.

- `/settings` becomes three registry-driven sections with explicit scope labels:
  **Station** (S1), **Defaults** (S2), **This device** (S3) — progressive
  disclosure, search across all of them, persistence-tier caption per section.
- Command palette gains entries for the sub-settings surfaces it currently
  omits (project settings, model connections, per-agent settings by name).
- Entity and Connections surfaces keep their routes; dead `/providers` alias is
  removed; Notifications toggle and `/notifications` inbox cross-link.
- archive#572's Agents/Skills/Models customization grouping and archive#536's
  provider-instance presentation remain their own issues; this design gives them
  the scope vocabulary and the registry to build on rather than absorbing them.

## 6. Slices (each independently shippable)

1. **Registry + typed contract + provenance (server core).** Registry module,
   typed PUT schema, provenance in GET, completeness tests. No UI change yet.
2. **Device store unification.** One versioned client-settings store; migrate the
   legacy localStorage keys; honest Export/Import.
3. **/settings IA restructure. Shipped (station#settings-revamp epic archive#1269).**
   Station / Defaults / This-device sections from the registry; surfaced the
   hidden S1 fields (approvalGuardian, maxTurns, maxOutputTokens,
   terminalShell, mcpUiHost, surfaceTrustFromVeritasEvidence, knowledgeStores,
   disableDefaultSkillRegistries, registryUrl, distributionProfile,
   builtinAgentEngineConnectionId) with provenance badges; registry-driven
   search; converged archive#1359's parallel device-settings root onto the slice-2
   envelope.
4. **Chat settings persistence. Shipped (station#settings-revamp, archive#1273,
   epic archive#1269).** Reasoning/tool-detail/font/dock-mode prefs moved to device
   scope (`chatShowReasoning`, `chatShowToolDetails`, `chatFontSize`,
   `dockSlotPlacement` in `DEVICE_SETTINGS_REGISTRY`) with explicit per-session
   URL-param override semantics (§3 S4); the save-model convention is
   recorded in §4.1 and every existing single-control surface audited
   against it.
5. **Naming and cross-links. Partially shipped (archive#2679).** The three
   Knowledge surfaces are named My knowledge store / Project knowledge /
   Knowledge infrastructure; Notifications and every other in-app Settings
   deep link use canonical `?view=` while the existing `?section=` fallback
   remains accepted. Effective-value chain work, the peer-credentials UI home,
   and `/providers` alias removal remain separate (the alias is owned by the
   concurrent routing lane).
6. **Plumbing debt.** `station config set` via live route (archive#175); wire the config
   watcher's events to the subscribers that S1 edits need (archive#983, scoped to what
   the settings surfaces consume).

**Save-model and device-store convergence shipped (archive#2679).** `/settings`
now exposes exactly two behaviors by scope: the Station + Defaults server
document is drafted behind Save/Discard (including `logLevel`), while This
device controls persist immediately through the versioned envelope. The
log-level-only revision key and queue UI were removed. All legacy raw device
preference keys migrate read-old/write-new/delete-old through the envelope;
theme and accent retain read-only pre-React compatibility reads so first paint
survives an upgrade before the migration constructor runs. An exact static
inventory test documents the non-setting localStorage state deliberately left
outside the envelope.

Slices 1–2 are foundations; 3 is the visible revamp; 4–6 ride the new rails.

## 7. Non-goals

- No org/enterprise policy tier — nothing demands it yet.
- No cross-device settings sync service — Station settings
  are server-authoritative per instance; device settings are deliberately local.
- No project-level `config` files for app settings — project scope stays entity
  config (`project.json`), not a config layer.
- Keyboard shortcut customization is now a device-scoped companion slice
  (archive#1353). It uses the same versioned device-settings record as model-picker
  preferences and the same live command registry as the command palette.
