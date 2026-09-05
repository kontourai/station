# Pre-tool blocking and grant delivery boundary

`EngineCapabilityMatrix.toolPolicy` declares only whether Station can make a
pre-tool blocking or grant decision on the actual tool-call path. It does not
claim that post-hoc configuration, quality, or uniform-stop gates are absent.

The managed Station engine delivers its full pre-tool chain through
`beforeToolCall`. Claude Code is partial: its `canUseTool` callback honours a
resolved agent's matching `tools.autoApprove` patterns, but it does not run
Station's stale-generation, delegated-tool, config-protection,
approval-guardian, or unattended-grant chain. ACP is equivalently partial at
its protocol `requestPermission` callback. Codex has no Station pre-tool
interception seam. Muse is also unsupported. An unknown external engine fails
closed with no pre-tool delivery.

## Which settings files can grant a Claude tool call (#1545)

In Ask mode (`approvalMode: 'ask'` → the SDK's `permissionMode: 'default'`) the
engine's own permission flow decides, and it honours the Claude settings files
the CLI loads. Left unset, the SDK's `settingSources` loads all of them —
`~/.claude/settings.json`, the workspace's checked-in `.claude/settings.json`,
and `.claude/settings.local.json` — so a repository with
`{"permissions":{"allow":["Bash(rm:*)"]}}` committed ran `rm` with no Station
approval request and no Station receipt. Cloning a repository is not consent.

How far that reaches, measured against `claude` 2.1.224 with a real turn in
`permissionMode: 'default'`: an `allow` rule in a loaded settings tier does
shadow the SDK's `canUseTool` callback outright — a `permissions.allow: ["Bash"]`
rule supplied through the `settings` (flag) tier ran the command with no
callback invocation at all. The project and local tiers carry one extra
precondition: in a workspace the CLI has never had trust accepted for
(`~/.claude.json`, per-directory `hasTrustDialogAccepted`), the same rule did
NOT shadow the callback. So the exposure needs a workspace the operator has
already accepted — which is the normal state of their own repositories, and not
something Station can see or rely on. Narrowing `settingSources` takes the
repository out of the cascade regardless of trust state; it does not depend on
that gate holding.

Station therefore pins `settingSources: ['user']` on every Station-managed
Claude session (`STATION_SESSION_SETTING_SOURCES`,
`src-server/providers/adapters/claude-adapter.ts`). The operator's own
`~/.claude/settings.json` still applies — that is what the Ask-mode chip copy
promises — and the two repository-writable tiers do not. The model-catalog
probe stays stricter at `settingSources: []`.

`settingSources` is not permission-scoped: an excluded tier is not read at all.
Measured against `@anthropic-ai/claude-agent-sdk` 0.3.224 (`resolveSettings()`,
`getContextUsage().memoryFiles`, `mcpServerStatus()`) on a workspace holding all
four files, narrowing to `['user']` also gives up:

- **The workspace's `CLAUDE.md`.** `memoryFiles` loses its `type: 'Project'`
  entry; the `type: 'User'` `~/.claude/CLAUDE.md` entry survives. This is the
  real cost of the remedy and a regression for an agent working inside a
  repository that documents itself there. An agent's own authored
  `systemPrompt` is delivered separately and is unaffected — repository
  instructions are not.
- **Project `.mcp.json` servers**, whose approval is recorded in project/local
  settings (`enabledMcpjsonServers`). User-scope servers survive. Nothing
  Station wires itself is affected: `resolveAgentToolServers` builds
  `mcpServers` explicitly, station-control included, and passes it with
  `strictMcpConfig`.
- **Project/local `hooks`, `env`, `model`, `statusLine`** and the rest of those
  two files. Station's own `PreToolUse` hook is the SDK `hooks` *option*, not a
  settings file, so the staged pre-tool policy is unaffected.

The narrower remedy that would keep `CLAUDE.md` —
`managedSettings: { allowManagedPermissionRulesOnly: true }` — was rejected
because it ignores *all* filesystem permission rules, the operator's own
included, which the Ask-mode copy promises still apply.

## Matrix authority

The matrix is authoritative for UI and conformance consumers. Its declared
adapter modules are also the source for the tripwire, so a declared adapter
module cannot silently gain a managed pre-tool seam while its matrix remains
stale. This does not claim that every possible `EngineId` string is a
registered adapter; unknown engines remain fail-closed through the separate
unknown-engine matrix.
