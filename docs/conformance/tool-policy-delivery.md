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
`tool` or `edit-mode` case of the session-grant computation below. That
computation reads the engine's structured reason for the ask (#2932), so a
pattern answers no safety check and no ask rule on a single command either;
the limits for chained Bash commands are stated there. An
autoApprove match in the staged evaluator (`toolGrant`) is therefore not
returned as a `PreToolUse` allow. After a hook allow, Claude Code 2.1.278
(read in its bundled binary, as 2.1.261 was first) re-checks only deny rules,
ask rules, safety checks and user-interaction tools, so the allow would have
skipped its working-directory check. The hook states no
opinion, and the engine asks `canUseTool` for anything it does not allow
itself.

An approval-guardian allow is handled the same way (#2947). The guardian is
shown the Agent's name, the tool's name and the call's arguments. On ACP it
is also shown the call's title as the tool description; the Claude hook
passes no description. It is not shown the session's working directories, its permission
mode, or why the engine would ask, so its allow speaks for the call as
written and not for an escalation. On Claude Code the hook states no opinion
for a guardian allow, and the adapter keeps the allow under the engine's
tool-use id, with the tool's name and a digest of the input the guardian
reviewed (SHA-256 of the input's JSON with object keys sorted). If the engine
then asks `canUseTool` about that call of that tool with the same input, the
allow answers it only where `toolRequestIsPlainCall` holds, and it is used
once. A different input, which another `PreToolUse` hook's `updatedInput` can
produce, consumes the allow without using it, and the request prompts. A
chained Bash command is a plain call, so a guardian allow answers it,
including what the chained-command gaps below leave invisible. When an allow
is not applied the adapter logs that and why. An escalation, a plan exit or a question reaches a person, and a
call the engine allows itself never consults the allow. The guardian is asked
once per call. At most 256 unanswered allows are kept per session; beyond
that the oldest is dropped, and a call whose allow was dropped prompts. A
guardian deny (enforce mode) is still a `PreToolUse` deny. What a hook allow
skipped was read in the bundled 2.1.278 binary and not reproduced in a live
session: after one the engine re-checks deny rules, ask rules, user-interaction
tools, safety checks, the MCP organization ceiling and a sandbox override, and
nothing else, so a working-directory ask and a plan-mode refusal were skipped.

On ACP, no staged-evaluator allow (a `toolGrant`, a pattern match or a
guardian allow) answers a request addressed to a person
(`toolRequestNeedsPerson`: a plan exit by `switch_mode` kind or
`ExitPlanMode`, `AskUserQuestion`, `SandboxNetworkAccess`). ACP reports no
other escalation signal, so there a guardian allow still answers every other
call. A session answer to an ACP plan exit is
an `accept` and mints no Station session grant. Its response mapper prefers
`allow_once` but falls back to `allow_always` when that is the only allow option,
so Station cannot guarantee one-call behavior in that agent;
the request payload carries `toolKind`, so a `switch_mode` request offers no
session option. In a delegated child that cannot grant approvals
(`delegation.denyApprovals`), a request either adapter would otherwise open is
denied at once with the staged evaluator's `delegation_deny_approvals` denial,
since nobody could answer it. That includes a question from such a child.
Known `AskUserQuestion` callbacks are handled before those grants: answering
a question requires an exact structured batch and never creates a session
tool grant. This is a question interaction boundary, not a new consent floor
for every tool or proof that the engine invokes every callback.
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

## Selected MCP tools

The Agent editor's tool selection is separate from approval grants.
`ResolvedAgentToolServer.allowedTools` carries exact selected MCP names; omission
means all, and an empty array means none. Claude removes known unselected tools
with `disallowedTools`, and its `PreToolUse` hook also refuses unknown/new MCP
names outside the selection. Codex receives `enabled_tools` and `disabled_tools`.
The Station Control HTTP token pins its selected names; the Claude in-process
server serves the same filtered registrations. A direct call to an omitted
Station Control tool cannot reach its callback. These filters do not relax the
existing per-call authority table.

Probe receipts store server-qualified names. The shared
[selection translator](../../packages/shared/src/mcp-tool-selection.ts)
resolves original, qualified and legacy normalized identities for external
Agent selection, integration disablement and App calls. Native available filters
also retain their framework-specific runtime/original-name matching.
Codex applies authored selection flags on the thread after reading its effective
MCP configuration, including same-name inherited disabled/subset flags. Replacing
an inherited allowlist requires a known integration inventory; missing inventory
is a startup refusal with an instruction to check the integration's tools.

Generic connected engines receive no restricted integration when their protocol
cannot enforce its individual-tool selection. The undelivered receipt reports
`engine-unsupported`. This is not a claim that Station controls those engines'
own tools or configurations. An explicit conversation engine override instead
refuses startup when required profile delivery is unsupported or undelivered;
it cannot reduce the selected Agent profile to fit the engine. See
[execution overrides](../reference/session-api.md#preserve-an-agent-profile-with-an-execution-override).

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
drops the reason's type, which Station reads from the engine's request
instead (see the structured reason below). Edit and Write outside them suggest `addDirectories`
(with `acceptEdits` in default mode). The Bash path checks report a
`blockedPath`, with a `Read` rule for a read and `addDirectories` for a write.
A directory suggestion is an allow rule for a file tool (Read, Edit, Write,
MultiEdit, NotebookEdit) or `addDirectories`. A Bash or PowerShell command
rule is never one, even when it names a path.

One shared computation, `toolRequestSessionGrant`, decides what a session
answer grants. The adapter honours it and the toast, inline card (on a phone,
its request sheet's overflow item, #3331) and inbox card label it:

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
  answer is recorded as a one-call accept. That covers an ask rule, a safety
  check (read, file edit or shell command), an ask
  whose engine request Station could not read, and `ExitPlanMode` (#2916). A
  plan exit therefore always prompts, and its suggested mode change is
  dropped.

A file-edit safety check the engine raises in default mode suggests
`acceptEdits` exactly as a plain edit does. Station tells them apart by the
structured reason below, so the check offers no auto-accept option (#2932).

Some escalations the SDK does let Station see, and those always prompt: no
tool grant and no agent `autoApprove` pattern answers them, even `*`
(#2932, part 1). They remain as a second layer under the structured reason.

- The sandbox network-host ask. Claude Code 2.1.278 (as 2.1.261) sends it
  as tool
  `SandboxNetworkAccess` with input `{host}`, a `WebFetch(domain:<host>)`
  allow-rule suggestion for `localSettings`, and no reason. It offers no
  session option and forwards nothing, and its title names the host
  ("Allow network access to <host>", an ASCII host bounded to 120 characters,
  otherwise "an unrecognised host"). The engine remembers a host it was
  allowed for its own session, so each new host prompts.
- A sandbox override: a call whose input sets `dangerouslyDisableSandbox:
  true`. The engine's own override ask carries no suggestion, so without this
  a Bash tool grant answered it.
- A `decisionReason` that is exactly `dangerouslyDisableSandbox`,
  `requiresUserInteraction`, or the MCP organization ceiling `Your
  organization requires approval for this tool`. These are literals in the
  engine. Nothing else in the reason text is matched. They are specific to
  the CLI versions they were read from (2.1.261, and byte-identical in
  2.1.278): if a later CLI rewords one,
  the rule stops matching and that ask goes back to being treated as an
  ordinary call. A wording change disables the rule; it never widens it.
  The durable signal is the structured `decision_reason_type`, read as
  described below.
- The ask flags `suppressAlwaysAllowRule`, `defaultToNo` and
  `requiresUserInteraction`. The CLI sends all three. Agent SDK 0.3.278
  forwards `suppressAlwaysAllowRule` and `defaultToNo` and still drops
  `requiresUserInteraction`, which the adapter reads from the engine's
  request (below).
  In 2.1.278 the engine sets these flags on escalations only: claude.ai
  artifact reads, writes and deletes, an MCP tool marked as requiring user
  interaction, an MCP connector's approval retry, a call run on a remote
  host, an ask rule whose full check could not complete, and auto-mode
  classifier review. A request flagged `suppressAlwaysAllowRule` also offers
  no session option.

The adapter sanitises `decisionReason` once (ANSI escape sequences, then
control, format and separator characters, bounded to 1000 characters) and
both matches and publishes that value. It copies it and any flag that is set
onto `request.opened`, so the surfaces compute the same grant. Sanitising
leaves the literals unchanged. The engine's `description` is published
sanitised the same way. The network title's host is checked against the
ASCII host syntax before any sanitising, so a host carrying an invisible or
control character is shown as "an unrecognised host", never as the host
left after the character is removed.

### The engine's structured reason (#2932, part 2)

Claude Code writes why it asks on each `can_use_tool` control request:
`decision_reason_type` (`rule`, `mode`, `subcommandResults`,
`permissionPromptTool`, `hook`, `asyncAgent`, `sandboxOverride`,
`workingDir`, `safetyCheck`, `classifier`, `other`), `classifier_approvable`,
`decision_reason_code` and `requires_user_interaction`. Agent SDK 0.3.278
hands `canUseTool` none of them. A test runs the real SDK against a stand-in
CLI and fails when that changes
(`src-server/providers/__tests__/claude-code-spawn.sdk.test.ts`). The request
shapes and reason texts below were read in the CLI bundled with that SDK
(2.1.278), not captured from a live session.

Station therefore owns the engine spawn through the SDK's
`spawnClaudeCodeProcess` option
(`src-server/providers/adapters/claude-code-spawn.ts`). The engine's stdout
passes through a tap that forwards every byte unchanged and records those
fields per `request_id`, which the SDK passes to `canUseTool` as `requestId`
(`claude-permission-frames.ts`). The tap also reads the requests replayed in
`pending_permission_requests`, only on the response to the SDK's `initialize`
request, which it recognises by watching the SDK's writes to the engine's
stdin; the SDK itself ignores a replay on any other response. A record is
consumed when the adapter reads it. Two requests that give one `request_id`
different reasons leave it unrecorded, so it reads as missing; the same
request seen twice is kept once. At most 256 unread records are kept; the
oldest is dropped beyond that. A stdout line longer than 8 MiB is forwarded
without being read.

`claudeAskEscalates` in the shared computation then decides, for both the
session grant and `toolRequestIsPlainCall`:

- A reason type other than `other` and `subcommandResults` escalates. That
  covers a `permissions.ask` rule on a single command (`rule`, which arrives
  with no reason text and, for WebFetch, looks exactly like the ordinary ask
  on the callback), a Bash, read or file-edit safety check (`safetyCheck`),
  a sandbox override, a path outside the working directories, and any type
  a later engine adds.
- `classifier_approvable` set, to either value, escalates. The engine sets it
  exactly when a safety check is involved, in the ask itself or in any part
  of a chained command, and sends `decision_reason` text with a chained
  command only then. Its absence therefore rules a safety check out.
- A `decision_reason_code` escalates. The engine sets one only for a block a
  host may act on (`outside_reads_blocked`, `memory_paused`,
  `classifier_transcript_too_long`).
- Type `subcommandResults` on PowerShell always escalates, so every
  PowerShell ask prompts. PowerShell wraps each ask in that type, and a
  single command with a security warning (Invoke-Expression,
  download-and-execute, elevation, encoded parameters, scheduled tasks, WMI,
  COM, a path check) arrives exactly like an ordinary command.
- Type `subcommandResults` on Bash is a chained command (`a && b`, `a; b`, a
  pipeline). By owner decision it is a plain call, so a Bash grant or
  `autoApprove` answers it, unless the request carries
  `classifier_approvable`, any `decision_reason` text, a `matched_ask_rule`,
  or one of the other signals above (a blocked path, a directory suggestion,
  a sandbox override, an ask flag). What that leaves invisible is listed
  under the gaps below.
- Type `other` escalates unless its reason is exactly `This command requires
  approval`, what 2.1.278 sends for a single Bash command no rule matched.
  Its other `other` reasons are checks: shell operators, an
  unparseable command, a `cd` before a write, a sed write, process
  substitution.
- No reason type is a plain call, except on a shell tool. It is the ordinary
  ask of an MCP tool, WebFetch, and a file edit inside the working
  directories. An ordinary Bash ask carries type `other` in 2.1.278, so a
  shell ask without a type is never the ordinary one and escalates. The
  engine does send such asks: a Bash path-check ask carries a blocked path
  and no reason type, and prompts on both counts. The rule also means an
  engine that stopped sending the field cannot turn every shell ask into a
  plain call.
- A Claude ask with no record escalates. This is the fail-closed rule: an
  unread, oversize, reshaped or evicted request costs a prompt, never a
  grant.

An escalation still offers the folder option when the engine suggested a
directory, so the `read-folder` and `folder` grants above are unchanged, and
a plain file edit still offers `edit-mode`. `request.opened` carries the
record as `claudeAsk` (`decisionReasonType`, `classifierApprovable`,
`decisionReasonCode`), or `null` when there was none, so the surfaces compute
the same grant. Other engines publish no `claudeAsk`, which says nothing.

What this costs, and what it still does not cover:

- **A chained Bash command hides what its parts raised (accepted gap).**
  The engine does not send the reasons of a chain's parts. A safety check
  on any part always prompts, and an ask rule on a single command always
  prompts. Under a Bash session grant or an agent's `autoApprove`, inside a
  chained command, these carry no signal and are answered:
  - (i) any `permissions.ask` rule that applies to the chained command or to
    one of its parts, exact or prefix, whenever the chain arrives as
    `subcommandResults`, which is when more than one part needs approval.
    With `Bash(git push:*)`, `make build && git push origin main` arrives
    with no `matched_ask_rule`; so does the same command under a rule
    written for the whole chain, `Bash(make build && git push origin
    main)`. When the ruled part is the only one needing approval (`ls && git
    push origin main`) the engine sends type `rule`, which prompts.
  - (ii) a write or delete outside the working directories in an `&&` or `;`
    chain (`make build && rm /outside/f`), or in a pipeline with an output
    redirect (`make build | sort > /outside/f`). The engine sends no blocked
    path and no directory suggestion, only command-rule suggestions. A
    pipeline part that names the path as an argument (`make build | tee
    /outside/f`) keeps its `addDirectories` suggestion and prompts, as does
    a single command.
  - (iii) a part's warning that is not a safety check.

  These gaps exist on `main` today: before Station read the structured
  reason, a Bash grant answered every chained command. Closing them needs
  the engine to send the nested reasons. The request shapes for (i) and
  (ii), and for the two guarantees, were captured from live turns against
  the bundled 2.1.278 CLI and are pinned, with Station's verdict for each,
  in
  `src-server/providers/__tests__/fixtures/claude-2.1.278-chained-bash-asks.json`.
  Gap (iii) was read in the engine's code, not captured.
- **Every PowerShell ask prompts.** See the type bullet above: a PowerShell
  grant or pattern answers nothing. The list of PowerShell security warnings
  there was read in the engine's code, not captured.
- **The ordinary Bash ask is recognised by its text.** `other` covers both
  the ordinary ask and safety prose, and only the text tells them apart. The
  text was read in 2.1.278. If a later engine rewords it, ordinary Bash calls
  prompt until the literal is updated; a rewording never widens a grant.
- **A different frame shape costs prompts, with one exception.** A request
  Station cannot parse is not recorded, so all Claude asks would prompt and
  offer no tool grant. A session can run an installed `claude` newer than
  the bundled one, so this can happen without a Station change. The
  exception: if an engine sent readable requests without the reason type,
  shell asks would still prompt, but an ask rule or safety check on any
  other tool (WebFetch, a file edit, an MCP tool) would read as a plain
  call. Those would be covered only by the part 1 signals, as before.
- **Exit errors.** The SDK appends the engine's stderr to an exit error only
  for its own spawn. Station keeps the last 2048 characters itself, redacted,
  and appends them to the `runtime.error` it publishes when the message
  stream fails. An exit error the SDK raises on another call does not carry
  them. The SDK also adds its `--debug-file` argument only for its own
  spawn, which matters only when SDK debug logging is on.

A session answer never writes the engine's settings files. Every suggestion
a session answer forwards is sent with `destination: 'session'`
(`mapClaudeDecisionToPermissionResult`), whatever the engine proposed, and
Claude Code (2.1.261 and 2.1.278) persists an update only for a `localSettings`,
`userSettings` or `projectSettings` destination.

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
included. Legacy/replacement selection passes `strictMcpConfig`; additive
selection preserves Claude's MCP discovery. Station's `PreToolUse` hook is
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
