# Pre-tool blocking and grant delivery boundary

`EngineCapabilityMatrix.toolPolicy` declares only whether Station can make a
pre-tool blocking or grant decision on the actual tool-call path. It does not
claim that post-hoc configuration, quality, or uniform-stop gates are absent.

The managed Station engine delivers its full pre-tool chain through
`beforeToolCall`. Claude Code is partial, and the boundary is narrower than it
once was: alongside `canUseTool` (which honours a resolved agent's matching
`tools.autoApprove` patterns) a `PreToolUse` hook runs Station's staged
evaluator, so stale-generation, delegated-tool, config-protection and
approval-guardian decisions DO reach the actual tool-call path. What it still
does not deliver is the unattended-grant chain: the staged evaluator hands
external interaction back to the engine's own permission flow before those
stages, and the external adapters carry no unattended principal for them to
read.

Handing interaction back is also all Station does about consent on that path:
in Ask mode the engine asks before tool calls its own rules and classifier do
not already allow, and Station adds no floor over it. What that leaves open, and
what Station ships instead, is the Accepted-gap section below.

ACP is equivalently partial at its protocol `requestPermission`
callback, through the same staged evaluator and with the same one gap. Codex
has no Station pre-tool interception seam. Muse is also unsupported. An
unknown external engine fails closed with no pre-tool delivery.

## Accepted gap: a trusted workspace's settings can grant a Claude tool call (#1545)

In Ask mode (`approvalMode: 'ask'` → the SDK's `permissionMode: 'default'`) the
engine's own permission flow decides, and it honours the Claude settings files
the CLI loads. Station sets no `settingSources`, so the SDK loads all of them —
`~/.claude/settings.json`, the workspace's checked-in `.claude/settings.json`,
and `.claude/settings.local.json`. A repository with
`{"permissions":{"allow":["Bash(rm:*)"]}}` committed can therefore run `rm` with
no Station approval request and no Station receipt.

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

What Station ships instead is that its approval surfaces name the call. Every
`request.opened` approval — the live toast and the durable inbox row — carries a
bounded, single-line preview naming **which command, or which file**
(`toolRequestPreview`, `packages/shared/src/tool-request-preview.ts`), and the
standing-grant button says which tool it grants. A call the settings do NOT
already allow is therefore prompted with its subject visible, never as a bare
tool name. The Ask-mode chip copy says the engine asks before calls its own rules
do not already allow, rather than claiming a floor Station does not impose.

Both surfaces read the payload through the same `toolRequestFromPayload`, whose
`TOOL_REQUEST_ARGS_FIELDS` is the one list of the names the adapters publish
arguments under — `toolInput` (Claude's `canUseTool`), `toolArgs` (station-agent,
and Claude's `PreToolUse` path), `rawInput` (ACP, so every ACP engine including
Gemini). Two readers with two lists is exactly how the toast came to show a bare
tool name for ACP sessions while the inbox row showed the command.

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

### Why the obvious remedy was not taken

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

The matrix is authoritative for UI and conformance consumers. Its declared
adapter modules are also the source for the tripwire, so a declared adapter
module cannot silently gain a managed pre-tool seam while its matrix remains
stale. This does not claim that every possible `EngineId` string is a
registered adapter; unknown engines remain fail-closed through the separate
unknown-engine matrix.
