# Pre-tool blocking and grant delivery boundary

This page combines current source contracts with historical provider probes.
The recorded Claude 2.1.224 / Agent SDK 0.3.224 experiments below were not rerun
for this review. The reviewed lockfile resolves Agent SDK 0.3.278; its installed
`sdk.d.ts` still documents that omitted `settingSources` loads all filesystem
settings. That dependency contract is not a fresh live test of permission-rule
precedence, workspace trust, or memory/MCP discovery.

`EngineCapabilityMatrix.toolPolicy` declares only whether Station can make a
pre-tool blocking or grant decision on the actual tool-call path. It does not
claim that post-hoc configuration, quality, or uniform-stop gates are absent.

The managed Station engine delivers its full pre-tool chain through
`beforeToolCall`. Claude Code is partial. For a session with a resolved Agent
and its evaluator, `PreToolUse` runs Station's staged evaluator before the call.
`canUseTool` also honors that Agent's matching `tools.autoApprove` patterns,
for plain calls only (#2933). A pattern never answers an escalation or a plan
exit, even `*`: it is allowed only where `toolRequestIsPlainCall` holds, the
`tool` or `edit-mode` case of the session-grant computation below. An
autoApprove match in the staged evaluator (`toolGrant`) is therefore not
returned as a `PreToolUse` allow. After a hook allow, Claude Code 2.1.278
(read in its bundled binary, as 2.1.261 was first) re-checks only deny rules,
ask rules, safety checks and user-interaction tools, so the allow would have
skipped its working-directory check. The hook states no
opinion, and the engine asks `canUseTool` for anything it does not allow
itself. On ACP, a `toolGrant` allow or pattern match never answers a plan exit
(`switch_mode` kind or `ExitPlanMode`). A session answer to an ACP plan exit is
a one-call accept (the agent's allow-once option) and mints no session grant;
the request payload carries `toolKind`, so a `switch_mode` request offers no
session option. In a delegated child that cannot grant approvals
(`delegation.denyApprovals`), a request either adapter would otherwise open is
denied at once with the staged evaluator's `delegation_deny_approvals` denial,
since nobody could answer it.
Stale-generation, delegated-tool, config-protection and approval-guardian
decisions therefore have a pre-tool delivery path. What it still
does not deliver is the unattended-grant chain: the staged evaluator hands
external interaction back to the engine's own permission flow before those
stages, and the external adapters carry no unattended principal for them to
read.

Handing interaction back is also all Station does about consent on that path:
in Ask mode the engine asks before tool calls its own rules and classifier do
not already allow, and Station adds no floor over it. What that leaves open, and
what Station ships instead, is the Accepted-gap section below.

ACP is partial at its protocol `requestPermission` callback through the same
staged evaluator. It has the unattended gap above and an additional coverage
limit: only calls that invoke that callback and report a tool name enter the
policy check, and the external engine reports that identity. Codex
has no Station pre-tool interception seam. Muse is also unsupported. An
unknown engine receives an unsupported matrix entry; that does not mean Station
intercepts or blocks all of that engine's tool calls.

## Accepted gap: a trusted workspace's settings can grant a Claude tool call (#1545)

In Ask mode (`approvalMode: 'ask'` → the SDK's `permissionMode: 'default'`) the
engine's own permission flow decides. Station sets no `settingSources`, so the
current SDK contract permits all filesystem sources —
`~/.claude/settings.json`, the workspace's checked-in `.claude/settings.json`,
and `.claude/settings.local.json`. A repository with
`{"permissions":{"allow":["Bash(rm:*)"]}}` is therefore not excluded by Station's
settings selection. The historical probes below established permission-rule
bypass of Station's approval callback under their stated conditions.

**This is an accepted gap, not an oversight.** Measured against `claude` 2.1.224
with a real turn in `permissionMode: 'default'`:

- An `allow` rule in a loaded settings tier shadows the SDK's `canUseTool`
  callback outright. A `permissions.allow: ["Bash"]` rule supplied through the
  `settings` (flag) tier ran the command with no callback invocation at all.
- The project and local tiers carry one extra precondition. In a workspace the
  CLI has never had trust accepted for (`~/.claude.json`, per-directory
  `hasTrustDialogAccepted`), the same rule did **not** shadow the callback. The
  user tier carries no such precondition: `~/.claude/settings.json` applies to
  every session regardless, because the operator wrote it for themselves.

So this reaches a workspace the operator has already trusted in Claude Code —
their own repositories, normally. That makes it a same-user threat model:
someone who can commit into a repository the operator trusts can already get
that operator to run their code. Station does not treat the checked-in file as a
separate escalation, and it adds no approval floor of its own over the engine's
permission flow.

Station's approval surfaces attempt to name the call. Tool approval requests
can carry a bounded, single-line preview naming **which command, or which file**
(`toolRequestPreview`, `packages/shared/src/tool-request-preview.ts`), and the
standing-grant button names the tool when the payload supplies one. Empty,
unsupported or unserializable input can produce no preview; the surface then
falls back to its title/tool label. The Ask-mode chip copy says the engine asks before calls its own rules
do not already allow, rather than claiming a floor Station does not impose.

The standing grant covers calls to the tool, never an escalation beyond the
call (#2915; #2911 set the same rule for Codex). The lockfile resolves Agent
SDK 0.3.278, which bundles Claude Code 2.1.278. That engine signals
escalations in several shapes, first read in 2.1.261 and re-checked in
2.1.278. Read, Glob, Grep and LSP ask for a path outside
the session's working directories without a `blockedPath`. They carry a session
`Read(//<dir>/**)` rule suggestion and the workingDir reason text; the SDK
drops the reason's type. Edit and Write outside them suggest `addDirectories`
(with `acceptEdits` in default mode). The Bash path checks report a
`blockedPath`, with a `Read` rule for a read and `addDirectories` for a write.
A directory suggestion is an allow rule for a file tool (Read, Edit, Write,
MultiEdit, NotebookEdit) or `addDirectories`. A Bash or PowerShell command
rule is never one, even when it names a path.

One shared computation, `toolRequestSessionGrant`, decides what a session
answer grants. The adapter honours it and the toast, inline card and inbox
card label it:

- A plain call to a tool grants every later call to that tool ("Allow Bash for
  this session"). Only this case mints a Station tool grant.
- A plain Claude file edit (Edit, Write, MultiEdit, NotebookEdit), outside plan
  mode and full access, allows the call and forwards only the engine's
  `acceptEdits` mode change ("Auto-accept file edits for this session"). The
  engine then passes later edits inside the working directories itself and
  still asks for sensitive files such as `.git/config`, and Station, holding
  no grant, prompts for those. The adapter records the forwarded mode as both
  the mode it requested and the engine's current mode, and reports it on
  `session.configured` metadata. The answer lasts until the user changes mode
  only when the answering caller holds `setApprovalMode` authority: an answer
  sent through the orchestration command route. There, once the engine has
  taken it, the orchestration service records an `auto` approval-mode
  decision for the conversation (`session.approval-mode-set`), as a composer
  pick of Auto would. If any decision was recorded after the answer was sent
  (Ask, Auto or full access), that decision stands and nothing is recorded.
  It is not recorded over a standing Auto or full access. The composer chip,
  later turns and their metadata then show Auto, and picking Ask ends it. An
  answer from another path is sent to the engine as a one-call accept: no mode
  change is forwarded and nothing is recorded. That covers the delegated
  `respond_to_task_request` path for a task on this Station, which admits a
  bound Project approver who may not set the approval mode, and the approval
  inbox. The inbox card does not offer the option at all. For a task on a
  saved Environment, the answer reaches that Station through its command
  route with this Station's enrolled credential, and that Station applies
  the same rule.
- A turn applies the conversation's approval mode only when it differs from
  the mode Station last requested, never merely because the engine moved. An
  engine that entered plan mode stays there through the user's follow-ups
  until the plan's review ends it. Picking a different mode is still applied.
  In plan mode the engine still suggests `acceptEdits` for a sensitive-file
  safety check, so an edit there offers no session option and forwards no
  mode change (#2916). The same holds under full access
  (`bypassPermissions`), where a forwarded `acceptEdits` would drop full
  access. Station learns of plan entry from the engine's `status`
  report, which reaches it on the message stream. A permission request raced
  ahead of that report on the control channel reads the earlier mode, and can
  still offer the auto-accept option for one edit.
- An escalation, or any Read, Glob, Grep or LSP ask, forwards only the engine's
  directory suggestions with `destination: 'session'`, so the approved
  directory is the engine's state. The button reads "Allow reading this folder
  for this session" for read rules and "Allow access to this folder for this
  session" otherwise. An `acceptEdits` suggested alongside is not forwarded.
- No session option is shown where there is nothing to forward, and a session
  answer is recorded as a one-call accept. That covers an ask rule, a read
  safety check, a file-edit safety check once the session is in `acceptEdits`,
  and `ExitPlanMode` (#2916). A plan exit therefore always prompts, and its
  suggested mode change is dropped.

Station cannot see the reason type behind an edit ask (the SDK drops it), so
a file-edit safety check the engine raises while it still suggests
`acceptEdits`, such as a Windows suspicious-path check, can still offer the
auto-accept option (#2932). Answering it allows that call and switches the
session to `acceptEdits`; the engine keeps asking for such paths.

Both surfaces read the payload through the same `toolRequestPreviewFromPayload`,
whose `TOOL_REQUEST_ARGS_FIELDS` is the one list of the names the adapters publish
arguments under — `toolInput` (Claude's `canUseTool`), `toolArgs` (station-agent,
and Claude's `PreToolUse` path), `rawInput` (ACP, so every ACP engine including
Gemini). Two readers with two lists is exactly how the toast came to show a bare
tool name for ACP sessions while the inbox row showed the command.

**Codex** names no argument bag at all — it has no Station pre-tool interception
seam, so its `request.opened` payload is the app-server's raw request params. The
same helper falls back to reading the payload itself, which is why
`item/commandExecution/requestApproval` previews its `command` and
`item/fileChange/requestApproval` previews the paths in `changes[]`. Without that
fallback a Codex file-change approval could name no file on either surface.
This is a best-effort presentation helper, not a completeness guarantee for
every engine request.

Two limits on "the preview", stated because a consent surface must not be read as
promising more than it does:

- **It is one field per tool family, not the whole call.** For `Bash` that is the
  command; for `Edit`/`Write`/`NotebookEdit` it is the file path and **never the
  content being written**, so the reader learns which file is about to change,
  not what it will say. It is also bounded to 160 characters on one line, so a
  long command's tail — a trailing `; rm -rf /` — can sit past the cap.
- **"Redacted" means known credential shapes.** `redactSecrets`
  (`packages/shared/src/redaction.ts`, see its docblock for the exact inventory)
  removes recognised credential patterns and `key=value` pairs whose key looks
  like a secret. An unrecognised token in an unrecognised field is rendered as
  written. It deliberately keeps paths and URLs, which are the substance of a
  preview. One consequence worth knowing: its contextual pass consumes the rest
  of the line after a redacted key, so a command with a secret in the middle can
  show its head and `[REDACTED]` and none of its tail — pre-existing behaviour,
  and in the safe direction.

### Historical settings-isolation experiment

Narrowing to `settingSources: ['user']` was built and reverted. The option is
not permission-scoped: an excluded tier is not read at all. Measured against
`@anthropic-ai/claude-agent-sdk` 0.3.224 (`resolveSettings()`,
`getContextUsage().memoryFiles`, `mcpServerStatus()`) on a workspace holding all
four files, `['user']` also gives up:

- **The workspace's `CLAUDE.md`.** `memoryFiles` loses its `type: 'Project'`
  entry; the `type: 'User'` `~/.claude/CLAUDE.md` entry survives. A repository's
  own instructions are how an agent working there knows what the repository
  expects. An agent's authored `systemPrompt` is delivered separately and is
  unaffected — repository instructions are not.
- **Project `.mcp.json` servers**, whose approval is recorded in project/local
  settings (`enabledMcpjsonServers`). User-scope servers survive.
- **Project/local `hooks`, `env`, `model`, `statusLine`** and the rest of those
  two files.

Trading a repository's instructions and tool servers to close a same-user gap
was not the trade. `managedSettings: { allowManagedPermissionRulesOnly: true }`
keeps `CLAUDE.md` but ignores *every* filesystem permission rule, the operator's
own included, so it contradicts the copy in the other direction.

Nothing Station wires itself depends on the cascade either way:
`resolveAgentToolServers` builds `mcpServers` explicitly, station-control
included, and passes it with `strictMcpConfig`; Station's `PreToolUse` hook is
the SDK `hooks` *option*, not a settings file. The one Station-owned Claude spawn
that does narrow is the model-catalog probe, pinned at `settingSources: []` — it
runs no tools and wants no ambient configuration at all. The session's unset
option is covered by a test, so setting it later is a deliberate change.

## Matrix authority

The [matrix](../../packages/contracts/src/engine-capability-matrix.ts) is authoritative for UI and conformance consumers. Its declared
adapter modules are also the source for the tripwire, so a declared adapter
module cannot silently gain a managed pre-tool seam while its matrix remains
stale. This does not claim that every possible `EngineId` string is a
registered adapter; the separate unknown-engine matrix reports unsupported
delivery.

Current source owners are the [Claude adapter](../../src-server/providers/adapters/claude-adapter.ts),
[ACP callback](../../src-server/providers/adapters/acp-adapter.ts),
[staged evaluator](../../src-server/runtime/agents/pre-tool-policy.ts), and
[managed hook](../../src-server/runtime/agents/agent-hooks.ts). Preview behavior
comes from the [shared reader](../../packages/shared/src/tool-request-preview.ts),
the [live approval handler](../../src-ui/src/hooks/orchestration/approvalHandlers.ts),
and the [durable request presentation owner](../../src-server/services/orchestration/request-presentation.ts). Fixture tests exercise these
branches; the matrix and tripwire do not prove live provider enforcement.
