# Design: Connections onboarding & capability passthrough

> Status: **direction recorded; onboarding slices shipping**. This doc captures the owner-set
> direction (2026-07-25/26 working sessions) for how the Connections surface onboards users,
> which connection types may be auto-surfaced by detection, how provider add-flows get their
> shapes, and the capability-passthrough path (MCP tools, skills) for External agents. It is the
> contract for follow-up slices; revise it — not just the code — when direction changes.
>
> The Connections overview now uses one user-facing category: **Providers**. It combines
> model services, agent apps, and detected local choices into one exact-ID catalog without
> exposing those implementation kinds. Each row has one of seven readiness labels and at
> most one next action. The guided setup slice is also shipped: Add Provider starts with a
> recognizable brand, then follows Choose → Connect → Ready; common fields stay visible while
> raw types, capabilities, commands, and provider-specific controls stay under Advanced.
> Existing setup URLs remain compatible. Everything else here is target state unless marked
> shipped.

## 1. The detection principle: observe infrastructure, never read secrets

Detection exists to shorten onboarding, not to configure on the user's behalf. The line:

- **Detect freely (no secret handling):** an installed CLI binary on PATH (`opencode`,
  `kiro-cli`, `cursor-agent`), a reachable local server (Ollama), the *presence* of an AWS
  credential chain, or the *names* of AWS profiles. These are suggestion data only; they can
  prefill or annotate an explicit Add choice, but do not create or change a Connection.
- **Never auto-read:** API keys from environment variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, …) or any other secret material. We don't know whose key it is, which
  account it bills, or whether the user wants Station using it. Silently importing credentials
  is the kind of magic that erodes trust in a receipts-first product.

Consequences:

- Key-based model providers (Anthropic, OpenAI-compatible, Google) are **always explicit
  add** — the assist is a good prefilled form (see §3), never a pre-created connection.
- Detected entries are *suggestions*, not state: nothing is written to configuration until the
  user explicitly adds the Connection.
- Detected providers may appear in the overview as **Found, not connected** or **Setup required**. Detection means Station observed a provider-specific setup signal on this computer: an executable, a reachable local service, or a credential chain. It does not prove that credentials are authorized for that provider; a connection is separate Station configuration.
  A detected row is still only a suggestion: it creates no Station connection until the
  user takes its explicit action.

## 1.1 Engine config ownership: the overlay model

Shipped: the audit that grounds the overlay model, the global-config refusal guard, and the
app-home profile channel — wave 1 (#896) shipped claude; wave 2 (#896) closes the
Codex spawn/import/auth/registry gaps the wave-1 audit named and adds bounded profile GC
(both below). The binding contract is `docs/design/agent-engine-unification.md` §6.1 —
Station never installs into the user's global CLI config; base config stays read-only, and
Station-managed additions stack per-session through three channels (wire > app-home >
workspace overlay). This section records the per-engine audit that fed that contract and
the shipped slices.

**Per-CLI config-surface audit** (verified-in-code unless marked to-probe or to-wire):

| Engine | Spawn path today | Env at spawn | Config-home override | Station read paths of that config |
|---|---|---|---|---|
| Claude Code | SDK `query()` in `claude-adapter.ts` (`startTrackedSession` → `buildOptions`) — **verified-in-code** | Inherited full server env until this wave; now optionally layered with the app-home profile — **verified-in-code**. SDK contract: `Options.env` REPLACES the subprocess environment entirely (never merges with `process.env`) | `CLAUDE_CONFIG_DIR` (plain env var; default `~/.claude`) — **verified-in-code** | `claude-auth.ts` (injectable `env` param); `claude-transcript-session-source.ts`; in-process SDK helpers `listSessions`/`forkSession`/`deleteSession` resolve the config root from the *server's* `process.env` and have no per-call config-dir override — **verified-in-code** |
| Codex | `spawnCodexProcess()` in `codex-adapter-transport.ts` (via `codexSpawnEnv()`, `CodexAdapter.startReservedSession` → `resolveAppHomeEnv`) — **verified-in-code** | Full inherit by default; layered with the app-home profile (`{ CODEX_HOME: dir }`) when the `codex` connection's `config.useAppHome` is `true` — **verified-in-code** (#896 wave 2). Model discovery (`listModelCatalog`) deliberately keeps the byte-identical global env — the profile is scoped to the session's own process only | `CODEX_HOME` (plain env var; default `~/.codex`) — **verified-in-code**, now wired end-to-end (spawn seam, import allowlist, auth detection) | `filesystem-skill-registry.ts`'s `defaultSkillRoots()` now also lists both engines' app-home profile `skills/` dirs (`<STATION_HOME>/app-homes/{codex,claude}/skills`), alongside the pre-existing `~/.codex/skills`/`~/.claude/.agents/skills` — **verified-in-code** (#896 wave 2, closing §1.1's previously-named gap) |
| opencode / ACP CLIs | `ACPProcess.start()` in `acp-process.ts` — `spawn(bin, args, {stdio, cwd, windowsHide, detached})`, no `env` key ⇒ full inherit — **verified-in-code** | Full inherit — **verified-in-code** | XDG (`XDG_CONFIG_HOME`/`XDG_DATA_HOME`) + `OPENCODE_CONFIG` — **to-probe**: spawn the CLI with overridden `XDG_CONFIG_HOME`/`XDG_DATA_HOME` in a temp home and observe where config/auth are actually read/written; Windows XDG honoring is unknown and also **to-probe** | none |

**The profile-dir contract:** `<STATION_HOME>/app-homes/<engineId>/`, keyed by the stable
engine id (`claude`, `codex` — also the built-in `AppConfig.agentConnections` keys and
each adapter's `engineId`). Created lazily on first opt-in / first profile-run session,
never at startup (`ensureAppHomeProfile`, `src-server/providers/app-home/app-home-profiles.ts`).
`claudeAppHomeEnv`/`codexAppHomeEnv` map a profile dir to the engine's env override; both
are wired to a live spawn path (#896 wave 2 wires Codex, mirroring wave 1's Claude wiring):
`ClaudeAdapterOptions.getAppHomeEnv`, threaded through `startSession` → `buildOptions`, and
`CodexAdapterOptions.getAppHomeEnv`, threaded through `startReservedSession` →
`processFactory` (`codexSpawnEnv`) — each applied only when that connection's
`config.useAppHome` is `true` — absent/false is the default, same "never silent" hygiene
rule as `provideSkills`. Both adapters report `appHome: 'profile'|'global'` on
`session.configured` and record the `station.providers.app_home_sessions` counter
(attrs: `provider`, `applied`). A lookup failure (or an absent `getAppHomeEnv`) degrades to
`undefined` — global config — on both adapters, never blocking session start. Adoption
(continuing a discovered Claude transcript) deliberately never applies the profile env — the
server-process SDK helpers it calls (`forkSession`/`listSessions`/`deleteSession`) are bound
to the server's own global config root with no per-call override, so running the forked
child under a different config home would orphan it there. Codex has no analogous
transcript-adoption path this wave, so no codex equivalent of this caveat exists — see the
toggle-boundary resume caveat below for codex's own analogous cross-config-home hazard.

**Import-from-global rules (claude):** an explicit, dedicated user action —
`POST /api/connections/agent/claude/app-home/import` — never automatic, never
triggered by the `useAppHome` toggle or a connection save. This is permitted under §1's
detection principle *because* it is explicit, not detection: the user affirmatively asks
Station to copy specific files. Allowlist (top-level entries of the global config dir
only): `settings.json`, `CLAUDE.md`, `skills/`, `agents/`, `commands/`. `.credentials.json`
copies only when the caller sets `includeCredentials: true` (a separate, explicit checkbox
in the UI) — on macOS, Claude Code's OAuth credentials actually live in the system
Keychain, config-dir-independent, so a profile without imported credentials can still
authenticate there; the status endpoint and UI surface this rather than presenting a
"failed" state. Always refused, never on any allowlist: `projects/`, `todos/`,
`statsig/`, `shell-snapshots/`, anything not listed above, any symlink anywhere in a
copied tree (refuse, never follow — same posture as the skills-materialization module
below), and any file over 5&nbsp;MB. Re-import is a snapshot overwrite of the profile's
prior imported copy at each name, never a merge (Station owns the profile dir). The
import module (`importClaudeGlobalSnapshot`) never writes outside the resolved profile
dir and never writes to the global source dir — both checked, not just documented, before
any write.

**Import-from-global rules (codex, #896 wave 2):** `POST
/api/connections/agent/codex/app-home/import`, the same explicit-action contract as
claude, sharing `importGlobalSnapshot`'s transactional/security machinery
parameterized over a codex-specific allowlist (`AppHomeImportProfile`). Allowlist: config =
`config.toml`, `AGENTS.md`, `prompts/`, `skills/`; secret = `auth.json` (holds ChatGPT OAuth
tokens / an API key) — copied ONLY under the same explicit `includeCredentials: true`
checkbox contract as claude's `.credentials.json`. Always refused, never on any allowlist:
`sessions/`, `archived_sessions/`, `history.jsonl`, `session_index.jsonl`, `log/`,
`shell_snapshots/`, `*.sqlite*`, `models_cache.json`, `installation_id`, `version.json`, and
any third-party addition — this machine's real `~/.codex` is heavily third-party-contaminated,
which is exactly why the allowlist stayed narrow rather than growing to cover everything
observed there. `rules/` is deliberately excluded pending evidence it is codex-owned config,
not a third-party addition. Disclosed caveat: `config.toml` may itself carry
`[mcp_servers.*.env]` secrets and `[projects]` trust entries — accepted under the same
explicit-user-action reasoning as claude's `settings.json`. Auth-state detection
(`detectCodexAuthState`) reads only `<profileDir>/auth.json` — unlike Claude, there is no
env-var shortcut and no macOS Keychain analog (`keychainAuthPossible` is always `false` for
codex); a user whose real CLI reads `cli_auth_credentials_store = "keychain"` in
`config.toml` shows as `unauthenticated` here even though the CLI itself may authenticate
fine outside Station's app-home profile — a conservative, disclosed direction, not a bug.

**The global-config refusal guard — workspace-overlay channel policy.** Any materializer
using the workspace-overlay channel (today: Claude skills materialization,
`claude-skills-materialization.ts`) MUST refuse a target that resolves — by real path, so
a symlinked session cwd cannot dodge it — into or across a boundary with any known global
engine config directory (`defaultClaudeGlobalConfigDirs()`: the resolved `CLAUDE_CONFIG_DIR`
and `~/.claude`, both checked). This guard runs BEFORE any directory is created — even an
empty `mkdir` inside the user's global config is already a violation. On refusal, every
requested id is skipped with the named reason `'global-config-target'` internally and
receipted to the capability-delivery contract as `'global-config-target-refused'`
(`CapabilityUndeliveredReason`, `packages/contracts/src/provider.ts`) — zero filesystem
writes occur. This is a live hazard, not a hypothetical one: a dirless project or global
agent defaults the session cwd to the user's home, where `.claude/skills/` *is* global
config. Wave 1 ships the guard as **receipt-only** — see the wave-2 defer below for the
designated fallback wiring.

**Wave-2 defers** (tracked in `agent-engine-unification.md` §6.1/§9, still not shipped —
CODEX_HOME wiring, the registry fix, and profile GC all shipped THIS wave, see above and
the GC mechanism below):

- **Auto-fallback of a refused workspace materialization into the app-home channel.** Wave
  1/2 stay receipt-only for the `'global-config-target-refused'` refusal — the reason is
  stable so wiring the fallback later is purely additive, never a breaking change to the
  reason taxonomy. Bounded design recorded for wave 3
  (`docs/design/agent-engine-unification.md` §6.1): `MaterializeSkillsInput` gains an
  optional `targetSkillsRoot` (the profile's `skills/` dir; containment + manifest +
  cleanup anchored there); `ClaudeSessionRecord` remembers the delivering root for
  `stopSession` cleanup; `CapabilityDeliveryChannelReport` gains an optional
  `channel?: 'wire' | 'app-home' | 'workspace' | 'flag'`; the fallback fires only when
  `materializeSkills` returns all-`global-config-target` AND `appHomeEnv` resolved.
- **opencode/ACP XDG overrides** — still blocked on the to-probe row above; no new evidence
  gathered this wave (this repo's ethos is probe behavior, not assert capabilities).
- **Per-agent (vs per-connection) app-home opt-in** and any editor-derived defaults defer to
  the §6.2 follow-up wave, matching the shipped `provideSkills` precedent.
- **Codex system-prompt delivery over `thread/start`'s `developerInstructions` wire param**
  — evidence-gated in wave 2 (`codex app-server generate-json-schema` against codex-cli
  0.145.0 confirms the param on `ThreadStartParams`/`ThreadResumeParams`/`ThreadForkParams`),
  but NOT shipped: the app-server protocol's `InitializeResponse` carries no version or
  server-capability field at all (only `codexHome`/`platformFamily`/`platformOs`/
  `userAgent`), and `InitializeParams`/`InitializeCapabilities` are client-declared only —
  so the version-skew honesty guard §5 requires (never send a wire param an older
  app-server would silently ignore) has no signal to gate on yet. `SESSION_DELIVERY_MAP`
  stays `codex: { systemPrompt: false }`; ships once a genuine version/capability signal
  exists (a `codex --version` CLI-level probe is the likely next mechanism — deliberately
  not built this wave, since it wasn't reviewed and needs its own design work).

**Profile GC (#896 wave 2, shipped — deliberately minimal, no daemons):** an app-home
profile was previously created lazily but never reclaimed. This wave ships a bounded,
on-request usage report (`readAppHomeProfileUsage` — an iterative, symlink-non-following
walk, hard-capped at `APP_HOME_USAGE_MAX_ENTRIES` = 10,000 entries, `truncated: true`
past the cap) surfaced on the existing `GET .../app-home` status response, plus an
explicit `DELETE .../app-home` clear action (`clearAppHomeProfile`). Containment is checked
BEFORE any `rm`, both by resolved-path comparison (same guard as `ensureAppHomeProfile`) AND
by an unresolved-path ancestor walk (`hasSymlinkAncestor`, security review 1a028fde HIGH)
that refuses if ANY component from the station home down to the profile dir is itself a
symlink — the resolved-path check alone cannot catch a symlinked app-homes ROOT, since both
sides of that comparison resolve through it consistently and still report "contained." The
clear route 409s with `Turn off "Run sessions in a Station-managed app home" for this
connection before clearing its app home.` while the connection's SAVED `useAppHome` is still
`true` — a proxy for "no session should currently be relying on this profile," not a
live-session check (Ambiguity F, accepted gap below). That 409 check is also not atomic with
a concurrent connection save (security review 1a028fde MED, accepted — no serialization
built): the window self-heals, since `getAppHomeEnv` recreates the profile lazily at the
next session start, and the only actor able to race it is the user's own UI acting on their
own Station-owned config. No background job, watcher, or timer exists or is planned — this
is the deliberate non-machinery direction under this repo's over-engineering guardrails; GC
is always a human's explicit action.

**Toggle-boundary resume caveat (codex, #896 wave 2):** a codex `resumeCursor`
(`{ codexThreadId }`) recorded while `useAppHome` was on lives under that profile's
`CODEX_HOME`; recorded while off, it lives under the global `~/.codex`. Toggling `useAppHome`
between a session's start and a later `thread/resume` attempt points the resume at the WRONG
`CODEX_HOME` — the codex app-server's `thread/resume` fails visibly (the thread id is not
found under that config home) rather than silently resuming the wrong state; sessions and
rollout files simply live under whichever `CODEX_HOME` wrote them. This is codex's analogue
of claude's "adoption never applies the app-home env" caveat above — codex has no
transcript-adoption path to carve an exception for, so the caveat is a documented resume
failure mode instead of an adapter-level design choice.

### 1.2 Credential-profile groups and verified recovery (#1237)

Credential profiles extend the app-home boundary without turning it into a second
credential vault. The persisted connection record carries only an opaque profile `ref`,
an optional **management-only** label, explicit group/enrollment metadata, default-off
automatic policy, and the current non-secret application projection. Credential material
stays exclusively in the selected Station-managed profile home; it is never copied into
the connection registry, response, CLI output, receipt, log, or metric. A ref is not an
account selector or an account identity.

**Filesystem boundary.** Legacy base app homes remain at
`<STATION_HOME>/app-homes/<connectionId>/`. A credential-profile ref is deliberately *not* a
path component: Station validates it (bounded, no separators/control characters) and
maps `(engineId, ref)` to a deterministic SHA-256-derived storage id before resolving the
profile home. Routes and UI return the ref/label only, never the profile directory. This
keeps a profile usable even when the legacy `config.useAppHome` toggle is off: an active
credential profile has precedence for ordinary future starts; only if there is no active
profile does Station use the legacy base app-home opt-in or the engine's global config.
An explicit selected-profile environment failure fails closed rather than silently falling
back to global credentials.

**Capability matrix and application.** Capability is adapter-declared, never inferred
from a provider name. Codex currently declares `restart_resume` and does not claim
`hot_apply`. Claude Code projects `unsupported`: changing `CLAUDE_CONFIG_DIR` cannot
isolate or prove a different macOS Keychain OAuth identity, so a successful turn would
not be authoritative adoption evidence. Codex application restarts the affected provider
process in the selected credential profile's app home and resumes/replays through the existing
recovery boundary. All other adapters also project `unsupported`: manual apply and
automatic policy are disabled, and Station does not guess at a safe credential switch.

**Manual-first operation.** Users add refs and optional labels, then explicitly import a
global snapshot into a selected credential profile when desired. The import's credential checkbox is
off by default; UI and CLI success reports expose only bounded copied/skipped counts and
provenance, never entry names or paths. The management API retains the existing app-home
import report of relative copied/skipped entries, but never returns the profile-home
directory or an absolute path. Applying a profile is a separate confirmed action: the
confirmation names one potentially billable provider verification turn. Station stages
the candidate while leaving the active ref unchanged; it commits only after that
provider-backed adoption succeeds. Failure, cancellation, conflict, or a stale terminal
event rolls the matching attempt back and preserves/reports the prior active state. A
pending candidate is visible as pending, an adopted candidate is success, and
`rolled_back`/`failed` are failure states that must never be rendered as successful
adoption. Active or pending/enrolled refs cannot be deleted.

**Automatic recovery is deliberately narrower.** It is off by default, and a profile must
be explicitly enrolled before it can be considered. Selection is fail-closed: only an
*observed*, account-scoped `rate-limit` or `capacity` failure may stage a different
enrolled profile; authentication, provider/server/unknown scope, a same-profile candidate,
or an unsupported adapter all refuse. The selected recovery restart/resume follows the
same stage → commit-on-live-success / rollback-on-failure protocol as manual adoption.

**Privacy and telemetry.** The bounded `station.credential_profile.application` metric
contains only source, declared capability, outcome, classified scope, and bounded reason.
It excludes profile refs, labels, profile paths, provider/engine identity, account identity,
credential material, raw runtime errors, prompts, and attachments. The same exclusions
apply to logs and recovery receipts. Profile refs and management-only labels appear only
on explicit profile-management UI/API/CLI surfaces; those surfaces still exclude
profile-home paths, account identity, credential material, and raw runtime data.

**Accepted gaps.** This is recovery from an observed failure, not proactive quota polling:
the #620 proactive quota-snapshot work remains separate. The implementation is stacked on
the Happier-continuity parent (#1247), so it cannot land independently before that parent;
the stack relationship is a delivery constraint, not an application fallback.

**Accepted gaps (disclosed, not defects — security review rounds 2-4, orchestrator-accepted):**

1. **Case-insensitive containment on darwin/win32 is a platform proxy.** The global-config
   refusal guard's case-insensitive comparison (`isPathContainedOrEqual` in
   `claude-skills-materialization.ts`) keys off `process.platform`, not an actual per-volume
   filesystem probe. A case-SENSITIVE APFS volume, or a Windows volume mounted
   case-sensitive, with a user who has legitimately distinct `.claude`/`.CLAUDE` paths
   would see a conservative false-positive REFUSAL from the guard on that platform — the
   guard fails closed (refuses a legitimate materialization target) rather than ever
   opening a bypass. Accepted: the failure direction is always the safe one.
2. **Source-side directory ancestor-swap TOCTOU during import remains path-based.**
   `importClaudeGlobalSnapshot`'s directory walk re-`lstat`s each entry at copy time and its
   file reads are descriptor-guarded (item 2 above), but the WALK itself still resolves
   nested paths by string concatenation, not by holding an open directory descriptor at
   each level — an attacker who can swap an ancestor directory component mid-walk (e.g.
   replacing `skills/pizza/` with a symlink to elsewhere between two `readdir` calls) is
   not fully closed by path-based re-`lstat`ing alone. Accepted because exploiting it
   requires an attacker with write access to the user's own home directory, concurrent
   with an explicit, user-triggered import action — at which point that attacker already
   controls the global config being imported in the first place, and the descriptor-side
   type/size checks (item 2) still bound what content is actually read even inside a
   swapped ancestor. Revisit if imports ever run unattended (a schedule, a background
   sync) rather than always as an explicit foreground user action.
3. **`ensureAppHomeProfile`'s marker-identity check has a post-check swap instant
   (security review round 3, honesty fix — not a new gap, a stated one).** Both identity
   checks (the initial `lstat`, and the post-`EEXIST` re-`lstat`) correctly refuse a
   non-regular marker found AT the check. What no path-based check can close is the
   instant immediately AFTER a check passes and BEFORE this function returns — a marker
   swapped for a symlink in that exact window yields at most a benign "ensured" report
   from this call. This is not a live overwrite risk: every LATER touch of the marker
   (`markAppHomeProfileImported`'s write, `readAppHomeProfileStatus`'s read) independently
   re-validates through `openForRead`'s no-follow descriptor path — including, as of
   security review round 4, the identity cross-check (`expectedIdentity`) on platforms
   without `O_NOFOLLOW` — and the write commits via `rename()`, which never follows a
   symlink at its destination — so a swap in this narrow window is structurally absorbed
   downstream, not exploitable into an overwrite or a read-through. Accepted as the
   honest description of what a path-based check can and cannot promise, not deferred
   work.
4. **Stage/backup PARENT-path symlink adoption, and crash-journal/startup-recovery for a
   mid-commit crash (security review round 4, accepted — not built).** (a) The import
   transaction's stage/backup LEAF directories are now created exclusively (`fs.mkdtemp`,
   round 4 item 1) so an attacker cannot predict — or pre-plant something at — the final
   path. What that does NOT close: an ANCESTOR path component of `profileDir` itself
   being swapped for a symlink between the earlier containment check and the `mkdtemp`
   call would still be followed — path-based directory creation cannot refuse-don't-follow
   an intermediate component without holding open directory descriptors at every level of
   the path, a materially larger architectural change than this slice's scope. (b) A
   Station process crash between the two renames of a single commit (the entry's own
   backup-away half succeeded, the stage-in half never ran) leaves no automated recovery —
   only a preserved, uniquely-named, logged backup dir inside the profile (round 4 item 3)
   and re-import (overwrite-in-place snapshot semantics, the pre-existing contract) as the
   documented recovery path; there is no startup scan or crash journal that auto-repairs
   it. Accepted for both: (a) requires an attacker who ALREADY has write access to the
   user's own `~/.station` — at that point they already control every Station config
   domain (agent specs, app config, connections) wholesale, not just this one profile,
   unlike #897's repo-working-tree write surface. (b) a recovery journal for an
   interactive, plainly-reported, user-triggered, freely-re-runnable operation is
   deliberate non-machinery under this repo's over-engineering guardrails — the preserved,
   named backup plus a re-import already gives a human operator everything needed to
   recover by hand, and building automated crash-journal replay for a narrow crash window
   is scope this repo's engineering-judgment discipline argues against building ahead of
   evidence of need.

## 2. Connections are user-level, owned by their environment

- Connections already persist in the Station home (`~/.station` app config): **add once,
  available to every project**. This is the intended model, not an accident.
- Cross-machine is explicitly *not* solved by syncing secrets. The unit of connection
  ownership is the **environment** (this computer, each SSH environment): every environment
  reports its own detected/configured connections. A Bedrock profile configured on the laptop
  does not pretend to exist on a remote host.

## 3. Provider add flow: presets over primitives

The registered connection *types* stay few and primitive (`bedrock`, `ollama`,
`openai-compat`, `anthropic`, `google` — `src-server/providers/connection-factories.ts`).
Onboarding breadth comes from a **preset layer**: named entries that resolve to a primitive
type with prefilled config.

- Shipped slice: OpenAI, OpenRouter, Groq, Fireworks AI, Meta (Muse Spark),
  xAI (Grok), Mistral, DeepSeek, Together AI, Cerebras, Vercel AI Gateway,
  Azure AI Foundry (the v1 `/openai/v1` surface is OpenAI-compatible with
  Bearer-header keys, so it presets; the base URL stays per-resource and is
  left for the user to paste), LM Studio, and LiteLLM presets over
  `openai-compat` in the add-connection flow (`providerCatalog.tsx` presets →
  provider picker pane → prefilled base URL/name in `ProviderConnectionForm`). The
  add flow is a routed selection in the Models split pane: the list remains the
  stable context while the provider picker occupies its detail pane. This is
  modality-ladder rung 2 (contained pane), not a modal interruption.
- Target shape: a descriptor-driven catalog — `{ id, name, resolvesTo, prefill, fields,
  detection?, docsUrl }` — contributable by plugins the same way the ACP connection registry
  is, so new routers/providers are data, not adapters.
- Genuinely new shapes (not presets): GCP Vertex — its OpenAI-compatible endpoint
  authenticates with short-lived OAuth tokens, not a static key, so it needs its own
  factory + form fields when prioritized. (Azure left this bucket when its v1 API made
  deployment/api-version handling unnecessary; the Gemini API with a key is already the
  `google` primitive.)

### 3.1 Bedrock is the sanctioned special case

Bedrock today is region-only over the default AWS credential chain. Target add flow offers
three auth modes, all inside the §1 principle:

1. **Default credential chain** — today's behavior; zero input.
2. **Named profile** — dropdown prefilled from profile *names* parsed out of
   `~/.aws/config` (names are not secrets); stores only the profile name.
3. **Bedrock API key** — explicit paste, for the chain-less case.

Mode 2 is per-environment by nature (see §2) and that is fine.

## 4. Hub hierarchy: simple questions, one provider concept

The Connections hub answers four plain questions: **which computers can I use**,
**what powers chats and agents**, **which developer services can work use**, and
**where does searchable knowledge live**.

- **Providers is one section.** Model services, native agent apps, configured command-backed
  providers, and detected suggestions share one exact-connection-ID catalog. Duplicate
  projections are removed, but separately configured instances of the same brand remain and
  carry visible names plus ordered accessible identities.
- **Readiness is finite.** Every row resolves to exactly one of **Ready**, **Sign in
  required**, **Found, not connected**, **Setup required**, **Limited**, **Disabled**, or
  **Unreachable**, with at most one primary action.
- **Implementation kinds stay behind the interface.** The default overview does not ask the
  user to choose between model connections, runtimes, engines, or ACP transports. Compatibility
  routes still lead to the correct existing detail screen.
- **Add owns configuration.** Supported catalog entries, detected suggestions, and custom
  setup remain explicit choices. Detection is useful context, never a configuration action.
- **One Add flow reports the result.** Selecting a catalog item or entering a custom command
  remains in the same dialog or sheet while Station checks it. The result is one of
  **Checking**, **Ready**, **Setup needed**, **Unavailable**, or **Off**, with one clear next
  action. A failed or incomplete check must not be represented as Ready. Raw command, argument,
  working-directory, and diagnostic details are available only under **Advanced**.
- **Developer services is one home.** Git, GitHub, GitLab, and MCP tool
  servers live together. Missing command-line tools and sign-in state are
  described inside the affected service, with one **Install**, **Copy sign-in
  command**, **Check again**, **Connect**, or **Manage** action. There is no
  separate CLI-management concept.
- **Unavailable tools route to their connection.** An agent tool backed by a
  disconnected MCP server cannot also claim to be available. Its primary
  action opens that exact tool-server connection for repair instead of adding
  a broken tool to the agent first.
- **Computers use one vocabulary.** Device pairing and remote execution remain
  distinct flows underneath one **Add computer** entry point. The overview
  calls the latter **Remote work**; protocol language such as SSH stays in the
  setup detail where it helps.
- **Knowledge stays** as the remaining capability tier.

### 4.1 The first-run gate: a durable fact about the home, on a surface of its own

The guided first run — "which of the agent CLIs on this machine do you use", then
the two "About you" questions — is gated on **one persisted field**,
`AppConfig.firstRun.status` in `<STATION_HOME>/config/app.json`, and rendered as
a dialog **on Home**.

**Why not readiness.** The run used to activate from `sawSetupLauncher`: only a
session that had SEEN the connect launcher counted as a first run. The
launcher's own visibility is `shouldShowSetupBanner(status)`, and
`setupBannerVariant` returns `hidden` as soon as **any** external engine reports
`ready` — so on a machine with `claude` or `codex` installed the launcher never
appeared and the entire guided run never ran (proved twice at runtime against
fresh homes). `/api/system/status` also flaps between `cannot_verify` and
`ready` under load, so a page load that landed in the `cannot_verify` window did
start the run: about ten seconds in, as a bottom-right notice-layer card, on
whatever route the user happened to be on, above modal scrims and the command
palette. A readiness probe is not a fact about a home, and it cannot be made
into one.

**The states, and what each means.**

| `firstRun` | Means | Home |
| --- | --- | --- |
| absent | This home's config predates the field — it has already been in use | Nothing |
| `pending` | The home was created and nobody has answered yet | Chapter opens; card present |
| `skipped` | Offered, and deferred with "Not now" | Card only |
| `completed` | Answered | Nothing |

`pending` is written in exactly one place: the branch of `loadAppConfigFile` that
runs when there is no `config/app.json` at all, i.e. for a home being created
right now. It is deliberately **not** back-filled onto an existing home — that
would claim a Station already in use had never been set up, and re-run the
chapter on every upgrade. `resolveFirstRunOffer`
(`src-ui/src/components/first-run/first-run-gate.ts`) is the single read, and it
fails closed for absent and for any status this build does not recognise.

**Placement.** `FirstRunHomeChapter` is mounted by `HomeView`, so it cannot
render on another route and cannot outlive the route the user left. It uses the
shared `ResponsiveDialogSurface` (the New Project modal's chrome) at
`--layer-dialog`, with that surface's scrim, focus trap and Escape handling —
never the notice layer, and never its own placement CSS. Its controls are the
shared `Checkbox` and `editor-btn`/`editor-btn--primary`; the amber primary and
the raw OS checkboxes are gone. A row Station cannot act on renders as a state
and a reason rather than as a disabled control, so the reason stays in the
document instead of behind a skipped tab stop.

**Ordering.** The connect launcher still goes first: while it covers the screen
the chapter does not auto-open (the same suppression `ProjectNewViewGate`
applies to the New Project modal). That decides only **when**, within one page
load, an already-decided run opens — never **whether** — and because the
auto-open is a one-shot latch it can only ever delay an open, never close a
chapter that is already up. So a flapping status probe changes what the
chapter's list says and nothing else.

**Enabling the engines.** Every ticked row goes through the one server path the
New Chat picker's per-row Enable uses: `POST /api/agents/materialize-engine`
with the engine's connection id and nothing else (station#3627). The chapter
builds no draft and invents no name — it used to, and "Set up 2" then produced
rows the picker's own Enable could not recognise as the same thing. Because the
endpoint is find-or-create, a second confirm or a second device adds no
duplicate, and its `created` flag is what lets the report distinguish "set up as
X" from "already set up as X" without a second read.

**Ending it.** "Not now" writes `skipped` and Home keeps offering the chapter
from a card in the page (not a floating one) until it is completed. Completing
writes `completed` and hands off to the tour, which `FirstRunFlow` still owns —
the tour is the one genuinely cross-route part of the guided run, because it
anchors coachmarks over real surfaces, and it is only ever entered on request.

**Completion is derived from the outcome, never from reaching the end.** A batch
in which any selected engine FAILED to materialise is not offered a plain
"Continue": the report's two exits are "Try again" — which re-plans only the
engines that failed — and "Continue without them", which writes `skipped` and
leaves the Home card offering the run again. `completed` is written only when
every selected engine was materialised (or none was selected); a warned
materialisation counts, because the Agent saved and the user now has it. The
questions are not even reachable from a failed batch, so the code path that
writes `completed` cannot be entered over engines that do not exist.

## 5. Capability passthrough to External agents

Direction: Station is the capability-provisioning plane for whatever agent app the user
prefers — not only a competing runtime. The mechanisms:

- **MCP tools per session — SHIPPED (spike proven GO 2026-07-26, productized same
  week):** driving `opencode acp` over stdio, `session/new` with a Station-provisioned
  stdio `mcpServers` entry (`@modelcontextprotocol/server-filesystem`) mounts cleanly:
  the agent enumerates all 14 tools namespaced `station-filesystem_*`, and a nonce-file
  round-trip (`read_text_file` on an unguessable fresh file → verbatim echo) proved live
  tool execution through the passthrough, with wire-level `tool_call` →
  `tool_call_update(completed)` events captured. Notes from productization: OpenCode's
  `mcpCapabilities` advertises only `{http, sse}` yet stdio mounts anyway — this repo
  probes behavior, not just capabilities; `session/request_permission` fires for
  passthrough tool calls and routes through Station's approval registry (the existing
  adapter path handles this); content fidelity remains a property of the underlying
  model, not the transport (an earlier probe saw the model paraphrase a file it had
  read — the nonce test is the discriminating method). Station-side wiring lives in
  `src-server/providers/adapters/acp-mcp-passthrough.ts` (`resolveAcpPassthroughMcpServers`,
  called from `acp-adapter.ts`'s `newSession` path with the connection's opted-in,
  resolved tool servers — see the security/id-safety notes in that module's header).
  Claude Code's SDK accepts per-session MCP config; Codex supports `mcp_servers`
  config — same contract, separate slices, not yet wired.
- **Skills materialization — SHIPPED (2026-07-26, security-redesigned same
  week after review):** Station skills are standard `SKILL.md` directories — the cross-CLI
  format Claude Code consumes natively. Passthrough = materialize the connection's opted-in
  skills (`AgentConnectionSettings.config.provideSkills` on the claude connection, off
  by default — same "never silent" rule as MCP passthrough) into
  `<sessionCwd>/.claude/skills/<id>/` before session start, so Claude Code's native skill
  loader picks them up with no Station involvement at chat time. Because this mechanism writes
  into the user's working tree (MCP passthrough never does), the hygiene bar is stricter and
  mechanically enforced, not just documented — and, after an initial review round found the
  delete path exploitable via a crafted manifest and race conditions, rebuilt around a
  resolved-root containment anchor rather than trusting path strings:
  - **Per-session manifests, no cross-session interference.** Each session owns
    `.claude/skills/.station-materialized.<threadId>.json` — a session only ever reads/writes/
    cleans its OWN manifest. Two sessions in the same `cwd` selecting the same skill resolve
    via an atomic, non-recursive, exclusive `mkdir` claim: the loser sees `EEXIST` and skips
    with a logged `target-exists-not-ours`, never touching the winner's directory.
  - **Manifest containment.** A manifest is fully validated (every skill id with
    `isSafeToolServerId`, every recorded relative file path rejecting absolute paths, `..`
    segments, and backslashes, the embedded session id matching the filename) before any of it
    is trusted; a manifest failing validation — corrupted or crafted — is quarantined (renamed
    `<manifest>.invalid-<ts>-<rand>`, logged) and never acted on, never silently unlinked.
  - **Resolved-root path containment.** `.claude/skills`'s `realpath` is the one trusted anchor
    for the whole call; every manifest-derived path is resolved by walking component-by-component
    from that anchor, refusing (not following) a symlink anywhere in the chain — including one
    nested inside a skill's own subtree.
  - **TOCTOU-safe delete.** A file is opened once; its content and identity (`dev`/`ino`) are
    read from that same descriptor, and only unlinked after a final fresh `lstat` on the path
    confirms the identical, non-symlink identity — a swap between verification and deletion is
    refused, not raced.
  - **Atomic claim, atomic write, tracked-only pruning.** A skill directory is claimed with a
    non-recursive exclusive `mkdir` (a lost race is never cleaned up by the loser); every file
    is written with the equivalent of `O_EXCL`; source entries are re-`lstat`ed at copy time
    (never trusted from a cached directory listing) and a symlink anywhere aborts that skill's
    copy; empty-directory pruning at cleanup only ever considers directories this module itself
    recorded creating, deepest first, and only when actually empty — a user-created empty
    directory living alongside materialized files is never touched.
  - **Crash-safety.** `sweepStaleManifests`, run best-effort at the next session's start, only
    ever touches an OTHER session's manifest that is both not currently live and past a grace
    threshold (default 5 minutes) — closing the race where two sessions start in the same `cwd`
    at nearly the same time.
  Implementation: `src-server/providers/adapters/claude-skills-materialization.ts` (pure-ish,
  injectable fs, no Station-substrate dependencies), wired from `claude-adapter.ts`'s session
  start/adopt/stop paths;
  materialization failure degrades to "no materialized skills" and never blocks session start. For
  CLIs without native skill support, degrading to their native command format (slash-command
  shims) remains a follow-up, not implemented here.
  - **Global-config refusal guard (#896, shipped):** the same module refuses (before any
    `mkdir`) a materialization target that resolves into the user's global Claude Code
    config — see §1.1 for the full guard contract and the app-home profile channel it
    complements.
- **App-home profiles (#896, shipped):** a second, opt-in delivery channel — see §1.1 for
  the full contract (profile-dir layout, per-session env layering, explicit import-from-
  global rules). Off by default (`AgentConnectionSettings.config.useAppHome` on
  claude), same never-silent posture as `provideSkills`.
- **Hygiene rule:** never silent, for either mechanism — same trust argument as §1 — but the
  *shape* of that rule differs per mechanism. MCP passthrough (shipped) is a wire-based,
  per-**connection** opt-in (`ACPConnectionConfig.provideToolServers`, off by default): nothing
  touches the user's working tree, the mechanism is naming a set of Station tool servers to
  mount into the agent's own `session/new` call. Skills materialization (also shipped, above) is the
  one that writes into the working tree (`.claude/skills/`, slash-command shims) and has its own
  explicit toggle plus cleanup/gitignore story — don't conflate the two. **Status (#895 wave A,
  shipped):** these per-connection opt-ins now act as **engine defaults** only — a per-agent
  authored field (including an authored empty array) takes precedence and fully replaces the
  connection default for that capability; see agent-engine-unification.md §6.2 for the resolution
  contract and `src-server/services/orchestration/session-agent-resolution.ts` for the
  implementation.
- **Secret boundary (shipped with MCP passthrough):** a tool server whose `ToolDef` declares any
  `env` entries is never passed through, full stop — `session/new`'s `mcpServers` payload is
  visible to the external agent app driving the session, not confined to the spawned MCP
  process, so an env-bearing tool server (API tokens, etc.) would leak across that trust
  boundary. Excluded entirely (not redacted key-by-key) and surfaced as a disabled, reasoned
  option in the tool-server picker — never silently omitted.
- **Contract impact:** this deliberately revises "skills and integrations are Station-agent
  capabilities only" — `docs/design/entity-hierarchy.md` and `docs/glossary.md` were both
  updated in the same change that shipped MCP passthrough.

What stays native-only: Station sitting inside the loop — per-tool permissioning, policy
gates, live receipts (partially reachable for Claude Code via hooks; out of scope here).

## 6. Slice map

| Slice | Status |
| --- | --- |
| Command-backed engine detection (suggestion data only) | Shipped upstream |
| Hub: configured command-backed providers first; catalog behind Add | Shipped in #572 |
| One Add → Checking → honest readiness result; Advanced command details | Shipping in #572 |
| Provider presets (OpenAI, OpenRouter, Groq, Fireworks AI, Meta, xAI, Mistral, DeepSeek, Together AI, Cerebras, Vercel AI Gateway, Azure AI Foundry, LM Studio, LiteLLM) + add modal | Shipped |
| Unified Providers overview, finite readiness, exact-ID deduplication | Shipped in #1349 |
| Detection cards (Ollama, Bedrock chain, local provider CLIs) | Shipped in #1349 |
| Bedrock auth modes (profile picker, API key) | Shipped in #1350 |
| Preset catalog as plugin-contributable descriptors | Target |
| MCP passthrough spike (one ACP CLI) | Done — GO (2026-07-26, nonce-proven live tool execution) |
| MCP passthrough productization (explicit per-connection opt-in `provideToolServers`, stdio-only, ACP session/new) | Shipped (2026-07-26, nonce-proven live tool execution via opencode + `filesystem_read_text_file`) |
| Skills materialization for External agents (claude, `provideSkills`) | Shipped (2026-07-26) |
| #896 wave 1: config-surface audit doc, global-config refusal guard (receipt-only), claude app-home profile + per-session env layering, explicit import-from-global | Shipped |
| #896 wave 2: Codex `CODEX_HOME` wiring, opencode/ACP XDG overrides, refused-materialization auto-fallback into app-home | Target |
| First-run gate: durable `AppConfig.firstRun`, Home dialog + re-offer card, shared dialog/Button/Checkbox (§4.1) | Shipped (UX audit RT-02, SHELL-12) |
| Azure OpenAI / Vertex shapes | Target, unprioritized |

### Later program boundaries

The unified Providers overview, guided setup, and chat model picker have
shipped. The following program work remains intentionally separate:

| Work | Owner |
| --- | --- |
| Unified Providers home and readiness language | #1349 — shipped |
| Provider detail and guided credential setup | #1350 — shipped |
| Default-chat Model picker | #1351 — shipped |
| Connection and tool prerequisite guidance | #1352 |
| Keyboard shortcut editor | #1353 |
| Settings integration and final interface polish | #1354 |
