# Engine profiles for the fake engine

Each `<engine>.json` drives `../fake-acp-agent.mjs` (ACP SDK agent side) in
`../../acp-engine-qualification.process.test.ts`. A profile describes what
the engine says on the wire. It is **not** a recording unless its row below
says so. Passing the conformance test shows that Station handles these
shapes. It does not show that the real engine sends them.

Provenance labels:

- **registry**: the public ACP registry snapshot fetched 2026-10-21
  (`registry` block: id, pinned version, distribution, command basename,
  args, env).
- **doc**: the vendor's published documentation, cited in the row.
- **researched-initialize**: an `initialize` run on 2026-10-21. It ran
  against the registry-pinned version, except for hermes, which is not in
  the registry, so the version that was probed is not recorded. Nothing after
  `initialize` was checked.
- **repo-observed**: a runtime observation already recorded in this
  repository, cited in the row.
- **recorded**: copied from a recorded wire exchange.
- **assumed**: a shape that is valid for the SDK schema but was not observed.
  Treat it as a placeholder.

## Fields that apply to every profile

| Field | Provenance |
| --- | --- |
| `initialize.protocolVersion: 1` | assumed (SDK `PROTOCOL_VERSION`) |
| `agentCapabilities.loadSession`, `promptCapabilities.image` | researched-initialize ("all probed agents advertise loadSession and image prompts"), except opencode (recorded) and kiro (assumed) |
| Other `agentCapabilities` (for example `mcpCapabilities`) | left out because they were not observed, except opencode (recorded) |
| `agentInfo` name, title, version | assumed (version is set to the registry pin; `0.0.0-assumed` where there is no pin), except opencode (recorded) and grok-build (left out: Grok Build sends no `agentInfo`, repo-observed in `services/acp/__tests__/acp-probe-session-reuse.test.ts`) |
| `authMethods[].name` and `description` | assumed. Some descriptions paraphrase a researched fact, such as the login command |
| `sessionNew` | left out (the probe sees no modes or config options) unless the row says otherwise |
| `permissionOptions` | the fake's default (`allow` / `reject`, assumed) unless the row says otherwise |
| Prompt script (the fake's default turn: text, plan, gated `execute` tool call, vendor notifications, `STATION_SMOKE_OK`) | assumed |

## Per-engine facts

| Engine | registry | `authMethods[].id` | Other sourced fields |
| --- | --- | --- | --- |
| goose | `goose` 1.55.0, `goose acp` | `goose-provider` (researched-initialize) | none |
| cursor | `cursor` 2026.10.19, `cursor-agent acp` | `cursor_login` (researched-initialize; doc) | modes `agent`, `plan` and `ask` with their descriptions, permission option ids `allow-once`, `allow-always` and `reject-once`, and the `cursor/update_todos` notification with the doc's example params (doc: cursor.com/docs/cli/acp). `currentModeId` and the option kinds and names are assumed |
| factory-droid | `factory-droid` 0.245.1, npx `droid exec --output-format acp-daemon`, env from the registry | `device-pairing`, `factory-api-key` (researched-initialize) | none |
| hermes | not in the registry | `openai-codex`, `hermes-setup` (researched-initialize) | none |
| antigravity | `antigravity-acp` 1.4.1, `agy_acp_server.par` (`args: []` is the darwin entry; the registry's linux entries pass `--uid=`, and its windows entries run `agy_acp_server.exe`) | `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` (researched-initialize) | none |
| pi-acp | `pi-acp` 0.0.34, npx | `pi_terminal_login` (researched-initialize) | none |
| kimi | `kimi` 1.52.0, `kimi acp` (no darwin-x86_64 build) | `login` is **assumed**. The research found only "terminal `kimi login`" | none |
| devin | `devin` 3000.11.92, `devin acp` | `browser-login` is **assumed**. The research found only "browser login" | none |
| cline | `cline` 3.0.73, npx `cline --acp` | `openai-codex` (researched-initialize). The research says the list *includes* it, so the full list is unknown | none |
| auggie | `auggie` 0.36.0, npx `auggie --acp`, env from the registry | `[]` (researched-initialize) | none |
| kiro | not in the registry | `[]` is assumed | `_kiro.dev/metadata` method name (repo-observed, station#1935 in `src-shared/extension-notification-bindings.ts`). Params are assumed |
| grok-build | `grok-build` 1.0.66, npx `grok agent stdio` | `[]` is assumed | `_x.ai/models/update` method name (repo-observed, station#1935). Params are assumed |
| opencode | `opencode` 1.19.3, `opencode acp` | `opencode-login` (recorded) | initialize, `sessionNew.configOptions` and permission option ids are recorded from OpenCode **1.18.18**, the same recording as `../fake-opencode-acp.mjs`. That is older than the registry pin |

## Fake handlers no test drives yet

The fake answers `authenticate`, `session/set_mode` and
`session/set_config_option`, but the qualification test does not call them
yet. They are kept for the sign-in and mode/model lanes. Treat their
behavior as unverified until a test drives them. The fake does not implement
`session/load` or `session/cancel`.

Every profile also runs the same fixed turn script (see the shared-fields
table). A profile has no per-engine prompt script.

## Relation to `fake-opencode-acp.mjs`

`fake-opencode-acp.mjs` cannot be expressed as a profile without changing its
behavior. It evaluates OpenCode's permission rules from
`OPENCODE_CONFIG_CONTENT` (last match wins), answers `debug agent`, writes
launch and resume records, and can refuse `session/resume`. Since #3991 it
also sends OpenCode's edit and `apply_patch` permission metadata, can write
through the client (`fs/write_text_file`), and remembers an `always` answer.
`opencode.json` carries only its static wire shapes: the initialize answer,
config options and permission option ids, which #3991 left unchanged. That
fixture is deliberately left as it is.

The qualification harness launches every profile through `node`, so the
adapter does not recognize the opencode profile as OpenCode
(`acpApprovalControl` reads the command). Station's OpenCode approval
governance is not exercised here. `acp-approval-mode.process.test.ts` covers
it through an executable named `opencode`.

## Adding a profile

Copy the closest profile. Change only fields you can source, and add a row
here with each field's provenance. Add the engine to the pinned list in the
conformance test. Never label an assumed shape as recorded. Keep user-specific
data out of profiles, including paths, account names and tokens.
