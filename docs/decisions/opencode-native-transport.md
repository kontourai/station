---
status: current
subject: OpenCode 2.x runs as its own engine over a verified `opencode serve`, with ACP as the fallback, behind a Feature Preview
decided: 2026-11-17
evidence:
  - kind: doc
    ref: src-server/providers/adapters/opencode-adapter.ts
  - kind: doc
    ref: src-server/providers/adapters/opencode-serve-fingerprint.ts
  - kind: doc
    ref: src-server/providers/adapters/opencode-serve-client.ts
  - kind: doc
    ref: src-server/providers/adapters/opencode-serve-pool.ts
  - kind: doc
    ref: src-server/providers/adapters/opencode-serve-session.ts
  - kind: doc
    ref: src-server/providers/adapters/opencode-native-mcp.ts
  - kind: doc
    ref: src-server/services/acp/opencode-steer-custody.ts
  - kind: doc
    ref: src-server/services/acp/opencode-approval-native.ts
  - kind: doc
    ref: src-server/security/managed-engine-limits.ts
  - kind: doc
    ref: src-server/providers/adapters/engine-command-dispatch.ts
  - kind: doc
    ref: src-server/providers/__tests__/fixtures/capture-opencode-serve-fixtures.mjs
  - kind: doc
    ref: src-server/providers/__tests__/fixtures/opencode-serve-2.3.0-openapi.json
  - kind: doc
    ref: src-server/providers/__tests__/opencode-serve-fixtures.test.ts
  - kind: doc
    ref: src-server/providers/__tests__/opencode-adapter.replay.test.ts
  - kind: doc
    ref: src-server/providers/__tests__/opencode-identity-policy.test.ts
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4435
---

# OpenCode native transport

## Decision

OpenCode becomes its own engine, `opencode`
([`OpenCodeAdapter`](../../src-server/providers/adapters/opencode-adapter.ts)),
behind the off-by-default `opencode-native-engine` Feature Preview. It picks a
transport for each session when the session starts or resumes:

- **Native**, for OpenCode 2.x: Station starts `opencode serve` and drives it
  over HTTP and its SSE event feed
  ([session](../../src-server/providers/adapters/opencode-serve-session.ts)).
- **ACP**, for everything else, through an unregistered `AcpAdapter` the
  OpenCode adapter owns under the `opencode` id. That covers OpenCode 1.x (npm
  `opencode-ai`), which stays ACP-only, a 2.x server whose API is not on the
  allowlist, a 2.x server that does not start, a session that asks for an
  `effort` setting, and every session while the preview is off. A session
  started as an Agent runs natively: Station's staged pre-tool policy runs on
  its asks there as ACP runs it on permission requests (see
  [Governance](#governance)).

Saved connections stay ACP connection records. The adapter runs the ones
`isOpenCodeAcpConnection` recognises: the OpenCode descriptor's own id, or a
command whose executable is `opencode` launched as `opencode acp`. It adopts no
session.

The preview decides which provider a **new** chat on such a connection gets
(`claimsAcpConnection`) and whether native may run (checked at every start and
resume, and by the pool before every spawn). A chat keeps the provider it
started with (`keepConversationProvider`). Chats from before the preview stay
`acp`, and no stored record is rewritten. Turning the preview off makes
existing `opencode` chats run over ACP. The adapter is always registered, so
those chats still have an engine.

## Why native first, with ACP as the fallback

OpenCode 2.x's ACP is a client of the same server: `opencode acp` starts a
private `serve --stdio` child and translates its events. A probe of v2.3.0
compared the two surfaces. The repository's evidence is the scrubbed capture of
that release
(`src-server/providers/__tests__/fixtures/opencode-serve-2.3.0-*.jsonl`) and
the findings the [fixture suite](../../src-server/providers/__tests__/opencode-serve-fixtures.test.ts)
asserts on it. Native serve offers things ACP does not:

| Capability | ACP (2.3.0) | Native serve (2.3.0) |
|---|---|---|
| Revert | No method (`-32601`) | Stage, commit, and clear (`revert` fixture) |
| Steer | A second prompt fails `-32603`; `_session/steering` works | `POST .../prompt {delivery:'steer'}`, acknowledged by `inbox.delivered` (`steer`) |
| Slash commands | Turn ends before the model runs; the command's output never streams | `POST .../command`; the output streams as the turn (`catalog`) |
| MCP status and control | None | `GET /api/mcp`, add, connect, disconnect, status events (`mcp`, `mcp-add`) |
| Approval rules | Station's 1.x check reads `debug agent <name>`, which 2.x does not have | Session `permissions` ruleset, agent rules and saved approvals readable over the API (`governed`, `permission-saved`) |
| Subagents | Opt-in `_meta` extension | Child sessions on the same feed with `parentID` (`subagent`) |

ACP stays as the fallback because the native API is new, changes between
releases, and is checked against an exact allowlist. OpenCode 1.x has no
`serve` API that Station checked.

The capture also settled what the design relied on
([fixture suite](../../src-server/providers/__tests__/opencode-serve-fixtures.test.ts)
findings a to j):

- An ACP session id is the native session id, both ways (`crossload`), so a
  session can move between transports.
- A user turn's message id is the prompt answer's id and its inbox id.
- 2.x has no `debug agent <name>`. `debug agents` lists the configured rules,
  not the approvals the person saved (`debug-agents`).
- Just after `/api/info` is ready, `GET /api/agent/{id}` answers 404 for a
  short time.
- `PATCH permissions: null` keeps a session's rules, and `[]` clears them.
- An interrupt drops a pending ask without `permission.replied`, and a late
  answer gets 404.
- Code Mode's `opencode.session_move` to a directory inside the project asks
  nothing, and OpenCode loads the destination's own plugins before it
  publishes `session.moved` (`move`). With a session rule denying
  `opencode_session_move`, the tool is not offered and the call fails as an
  unknown tool (`move-denied`).
- A child may start its own child when `experimental.subagent_depth` is raised
  (the default allows one level). Its ask, raised while the feed was down, is
  listed by `GET /api/permission/request`, and the descendants by
  `GET /api/session?parentID=` (`subagent-gap`).
- After a session moves, its ask raised while the feed was down is listed by
  its own `GET /api/session/{id}/permission`, not by the server-wide
  `GET /api/permission/request`, which lists the server's launch directory
  (`move-gap`).

## Transport selection and the fingerprint allowlist

1. `<binary> --version`, cached by binary identity (real path, size, mtime).
   Only a first line exactly of the form `[opencode ][v]X.Y.Z[-pre]` is read.
   Anything else means unknown, which means ACP.
   ([probe](../../src-server/providers/adapters/opencode-version-probe.ts))
2. For 2.x, the pool starts a server and waits for it to be ready.
3. Station reads `GET /openapi.json`. It keeps only the operations in the
   client's route table, the component schemas they reach, and the event type
   list. Documentation keywords are dropped. The SHA-256 of that projection as
   canonical JSON must equal `OPENCODE_SERVE_VERIFIED_FINGERPRINTS[version]`
   exactly ([fingerprint](../../src-server/providers/adapters/opencode-serve-fingerprint.ts)).
   Only `2.3.0` is listed. A pre-release keeps its suffix, so it never matches.
4. On a mismatch, the server is stopped and the session runs over ACP with a
   `runtime.warning` coded `OPENCODE_NATIVE_UNVERIFIED`. A server that did not
   start gives `OPENCODE_NATIVE_UNAVAILABLE`, and an `effort` setting gives
   `OPENCODE_NATIVE_UNSUPPORTED_SETTING`.
5. A verdict from a document that was actually read is kept per binary identity
   and version. A failed read is not kept.

## Models and steering

A new native session validates a requested `provider/model` selector against
`GET /api/model` before creating the session. An unqualified, missing, or
disabled model is refused. Every subsequent turn with an explicit selector switches through
`POST /api/session/{id}/model` before sending its prompt. A failed switch sends
no prompt and requires a confirmed model selection before more work. ACP
fallback keeps its existing model; choosing another model requires a new chat.

The live session reports native steering on the server transport and on an ACP
handshake that selects a native channel. Other ACP sessions advertise the
shared cancel, wait, and continuation fallback. Queue remains the default for
that fallback; an explicit Steer interrupts the current step.

After a native feed gap, only the exact steer message in history establishes
delivery. Absence from the inbox alone is not an acknowledgement. If withdrawing
a late steer fails, the session accepts no successor work and reports that the
input may remain queued. Before each steer POST, Station records its id in a
[crash-safe journal](../../src-server/services/acp/opencode-steer-custody.ts) under its runtime home (`service/engine-effects/opencode-steers/`),
scoped by the native data-home binding and session id. It clears the id only
after an exact delivery receipt, or a confirmed POST followed by confirmed
withdrawal. An uncertain POST keeps
the record even if a subsequent DELETE says 404: the POST may still finish
later. A session with such a record cannot resume on either transport; start
a new chat. The journal stores ids, never message text. It lives under the existing lifecycle-owned `service/` root so an update
rollback using the preceding version's registry preserves the journal's bytes
instead of restoring an older list. Earlier versions without journal enforcement
are not thereby qualified to enforce that custody. A resume also refuses
a session whose OpenCode inbox still has queued input.

## Server pool and isolation

[`OpenCodeServePool`](../../src-server/providers/adapters/opencode-serve-pool.ts)
runs one server per connection, binary identity, real working directory,
launch environment and tool-server digest. Every session with that key shares
the server, which stops after five minutes unused. A server whose key carries
one session's own minted credentials (Station's built-in tool servers) cannot
be shared, so it stops with that session instead of idling.

A governed start checks governance before it is claimed (`preflightStart`),
which needs a server. The preflight keeps the lease it checked on, and the
start moves that server to its tool-server digest's key (`rekey`, only while
that lease alone holds it and nothing was added), so a governed start runs one
server, not two.

- The server runs as `serve --stdio --hostname 127.0.0.1 --port 0`.
  `--stdio` ties the server's life to Station's end of its stdin pipe.
- It is started through `spawnOwnedChild`, so the startup sweep reaps a server
  a crashed Station left behind. `TMPDIR` is the engine spawn directory.
- It uses the real path of the working directory, because OpenCode keys
  locations by the path it is given (`/tmp` and `/private/tmp` would be two
  projects). Session create also sends `location.directory`.
- `OPENCODE_PASSWORD` is 32 random bytes held only in memory, used for HTTP
  Basic auth as user `opencode`. An inherited `OPENCODE_SERVER_PASSWORD` is
  dropped.
- The [client](../../src-server/providers/adapters/opencode-serve-client.ts)
  sends only the method and path templates in `OPENCODE_NATIVE_ROUTES`,
  matched segment by segment. It refuses any path holding `%`, `//`, `;`, a
  backslash or a dot segment. A never-allow list is checked first, so a route
  added to the table by mistake still cannot reach these: credentials, provider
  sign-in, pairing, server sign-in, client MCP and terminal tokens, and config
  writes. Refusals happen before any network I/O.
- Redaction covers configuration only: `GET /api/model`, `GET /api/mcp` and
  `GET /api/agent/{id}` answers and the configuration-type feed events. Conversation content is
  never rewritten.
- Station's tool servers for a session are the ones the ACP path would pass,
  resolved the same way. Each is added with
  `PUT /api/experimental/mcp/{name}`
  ([native MCP](../../src-server/providers/adapters/opencode-native-mcp.ts)).
  An added server belongs to the server's location, which every session on
  that server shares. So the pool key includes `openCodeMcpDigest` of the
  session's set, and sessions whose tool servers differ never share a server.
  Station's built-in servers carry per-session bearer tokens, so in practice a
  chat with Station tool servers gets a server of its own.

The SSE feed has no event ids and no replay. When the feed drops, or is silent
for longer than three missed heartbeats (45 seconds), the session reconnects
with back-off. After `server.connected` it re-reads over REST: the session's
status, its history (with the text a part finished during the gap), its own
pending asks and forms, its descendants and theirs, and the inbox. It also
emits the terminal event if the execution ended while the feed was down.

- The session's own asks and forms come from its own lists
  (`GET /api/session/{id}/permission`, `/form`), which follow it to wherever it
  moved.
- Descendants (children, and their children at any depth) are looked up by
  `parentID` from the session down, four lookups at a time and at most 200
  descendants in all. Past that the walk stops and a warning says so. Every descendant is looked up, including one
  that was idle before and after the gap: OpenCode's subagent tool resumes an
  existing child (`sessionID`), so a parent may have woken it during the gap,
  and it may have started a child of its own and gone idle again. One running
  now is reported as running child work, and one reported running that ended
  in the gap is settled with the outcome OpenCode kept.
- Descendants' asks and forms come from the server-wide lists
  (`GET /api/permission/request`, `GET /api/form`), kept only for this tree,
  since a server can run other chats' sessions. Those lists hold only the
  server's launch directory (`move-gap` capture: a moved session's ask is in
  its own list only), so a descendant in another directory is read from its
  own lists. Directories are compared at their real paths: OpenCode reports a
  move as it was asked (`/tmp`, not `/private/tmp`).

Each of these reads stands on its own: whether the session runs, its history,
each of its own lists, each descendant lookup, each server-wide list, each
descendant's own lists, and the inbox. One that fails is reported in a warning
of its own and the others still run. A failed lookup leaves out only that
descendant's children. What needs a failed read is left as it was: without
the running list, no child and no turn is settled and no steer is resolved.
The bookkeeping between the reads is guarded the same way, so an error there
is a warning and the feed that just reconnected stays open.

## Governance

Ruling R1 now covers confined approval modes on OpenCode 2.x over ACP.
Station's ACP approval check reads 1.x's `debug agent <name>`, and 2.x keeps
saved approvals that check cannot see. The version comes from the binary a
launch would run: the managed policy's `acp` pin when set, otherwise the
connection command. Ask, Auto, and confined Never ask are refused with
`acp_approval_governance_refused`. Host Never ask is supported: it answers the
asks OpenCode makes, without claiming to force every action to ask. Without a
Station mode, OpenCode's own approvals apply. No 2.x launch overlay is built.

Natively ([rules](../../src-server/services/acp/opencode-approval-native.ts)):

- **Full access in a `host` session** sends no Station session rules. The
  agent's own rules decide, OpenCode asks only where they say ask, and Station
  answers `once`.
- **Ask, Auto, and full access confined to Auto** send `ask` rules for
  `shell`, `edit`, `webfetch`, `websearch`, `external_directory`, `*_*` (MCP
  tools) and `subagent`. OpenCode appends a session's rules after the agent's
  and lets the last match win, so these asks reach Station even for actions the
  agent's own rules deny. Last, they deny `opencode_session_move`, Code Mode's
  session move. That is the only Station `deny`. No agent rule governs that
  tool, so the deny takes nothing from the agent. It closes a boundary: the
  move asks nothing for a directory inside the project, and OpenCode loads the
  destination's configuration and plugins while resolving it, before
  `session.moved` is published, so no check after the event could keep that
  code from running. A wholly denied tool leaves OpenCode's catalog, and
  children inherit the rule.
- A Station Project session keeps its recorded checkout in every approval
  mode. Its native session rules disable Code Mode's move tool. Station stops
  a live Project session moved by another client and refuses native recovery
  if OpenCode reports a different checkout.
- **A session that moves anyway** (another client of its server, or a resume
  of a session moved earlier) is followed. In a governed session, a
  `session.moved` for it or a descendant runs the #3924 scan on the new
  directory. Code there stops the session through the usual stop path (the
  execution interrupted, asks rejected), after a `runtime.warning` coded
  `OPENCODE_SESSION_MOVED_UNGOVERNABLE` that names the directory and what was
  found. Otherwise the session's directory follows the move: the
  configuration-edit guard, later governed checks and the resume cursor use
  it. A resume reads the stored session's directory and scans that.
- **Answering an ask**: if the asking agent's rules alone deny it, or it is
  `subagent`, Station rejects it without a person. Below host full access, an
  `edit` of OpenCode configuration (`opencode.json(c)`, `.opencode/`, the
  global configuration, or anything outside the project) and an
  `external_directory` ask for a directory that is or holds OpenCode
  configuration go to a person, whatever grant or mode would answer them:
  OpenCode reloads that configuration and runs what it declares (MCP servers,
  plugins) without asking (`openCodeNativeAskNeedsPerson`, the native
  counterpart of the ACP path's `openCodeEditNeedsPerson`). Otherwise, a
  session grant or the mode (full access answers everything, Auto answers
  `edit`) answers `once`. Otherwise a person decides, except in a delegated
  session whose delegation sets `denyApprovals`: nobody can answer it, so the
  ask is rejected at once with the delegated denial as OpenCode's feedback,
  at the point where the ACP adapter declines it (after the policy, a grant
  and the mode). Such a session's questions are cancelled, as ACP declines
  them. Station never answers `always` (ruling R4).
- **An automatic answer OpenCode refuses** (other than a 404 for an ask
  already gone): a `once` is put to the person, so the ask never waits
  hidden. A rejection (the policy's deny, the agent's kept deny, the #4828
  decline, a delegated session's decline) is sent once more. Refused again,
  it fails closed: it is never shown to a person who could allow it, and a
  later re-list does not reopen it. Station interrupts the execution that
  asked, which drops the ask. The session's own ask stops the turn it was
  raised in, and a descendant's ask stops the live turn if that turn started
  the descendant. Station interrupts the asking descendant (a 2.3.0 subagent
  is a background job that the root's interrupt does not stop) and the
  session. The turn then ends with a `runtime.error` that gives the reason.
  It ends once OpenCode reports the execution ended (on the feed, or on a
  reconnect that finds the session idle), or after three seconds if OpenCode
  does not. Until then the turn is still live, so a next turn is refused as
  busy and a steer as too late, rather than delivered into the execution
  being stopped. When the wait runs out, the turn's queued steers are
  withdrawn and its open tools closed. A second refusal in the same turn
  keeps the first one's reason and wait. A turn that nothing runs yet has
  its prompt taken back out of the inbox once its POST lands, and the error
  says whether that worked. If Station could not take it back (a command
  has no inbox item, or the withdrawal failed), an execution OpenCode
  starts while no turn is live, before it accepts Station's next prompt,
  command or compaction (and keeps it: one taken back out again does not
  count), is taken to be that prompt and interrupted with a warning (a
  command has no id to match the start against). Some asks are not the live turn's: one from a descendant that
  an earlier turn started and that still runs in the background, or the
  session's own ask from a turn that has already ended. Station interrupts
  the session that asked, with a `runtime.warning`, and the live turn goes
  on. When the ended turn's execution has ended too, OpenCode dropped the
  ask with it, so Station interrupts nothing (an interrupt would stop only
  the live turn) and the warning says so. The session's own ask with no turn live ends in a
  `runtime.error` of its own, and a next turn is refused as busy until the
  interrupt answers or the same three seconds pass. An interrupt that fails
  gets a warning of its own. The error then says OpenCode may still be
  running the turn, including when a descendant's interrupt failed and that
  descendant has not been seen to end. Until OpenCode reports the asking
  session's execution ended, stopping the session counts the ask as running
  work: it interrupts that session again and repeats the rejection. So
  does an ask whose automatic answer Station was still deciding or sending
  when the session stopped: the stop rejects it and interrupts the
  descendant that asked. A
  refusal that comes back after that execution ended counts as nothing
  held. Station remembers at most 200 refused asks that OpenCode no longer
  holds, and never forgets one it may still hold. Past 1,000 of those it
  stops the chat with an `OPENCODE_REFUSED_ASKS_OVERFLOW` warning.
- **After an untrusted read** (#4828), an `edit` ask from the session or a
  descendant that names a known agent-instruction or git-hook file, as a
  resource or in `metadata.files`, is rejected before any deny check, staged
  policy, grant, mode or person. It asks the same ledger and ancestry as the
  ACP path (`untrustedContentAncestry`). OpenCode names files relative to the
  asking session's directory (the descendant's own, and the session's after a
  move), so each file is classified as named and at its absolute path there
  (`openCodeNativePersistenceTarget`): a hook under a custom `core.hooksPath`
  is found only at its absolute path. A shell command's ask is not
  classified, as on ACP.
- **Station's staged pre-tool policy** runs on the asks of a session started
  as an Agent, its own and its descendants', as ACP runs it in
  `requestPermission`. The evaluator is resolved at start from the same
  `resolvePreToolPolicy` option, with the same input; a failed preparation
  yields one that denies every call with the reason ACP gives. It is asked
  with OpenCode's name for the asking tool, the one OpenCode's own ACP layer
  reports as `toolCall.name` (the tool part's name from
  `session.tool.input.started`, such as `shell`, `edit` or an MCP tool's
  `<server>_<tool>`), the call's input from `session.tool.called` (the ask's
  metadata when that is not known), the Agent, the conversation and its
  delegation, as an external interaction. The ask must fit that tool: its
  action is one the tool asks for in 2.3.0 (its own name, which is also an
  MCP tool's action, or `edit`, `external_directory`, `skill` or `webfetch`
  for the tools that ask those, `openCodeAskFitsTool`), and its message is
  the tool call's when both name one. Code Mode runs its nested calls under
  the `execute` call's own id and message, so a nested ask names `execute`.
  An ask that does not fit is treated as one whose tool OpenCode did not
  name. An evaluator that throws, at once or later, denies. The order
  follows ACP's: the #4828 decline first, then the asking agent's kept deny (native only; over ACP
  OpenCode enforces it), then the policy. Its deny rejects the ask with its
  reason as OpenCode's feedback, which fails the tool with that text and lets
  the turn go on (a live 2.3.0 test); ACP's decline carries no reason. Its
  allow answers `once`, except for a request addressed to a person (a tool
  named as a plan exit or a question, `toolRequestNeedsPerson`, which
  matches in any casing or separator, so an MCP tool `exit_plan_mode` too)
  or one the configuration-edit guard gives a person, which ACP's `needsPerson` also
  holds back. Its required ask goes to the person. Anything else goes on to
  the grant, the mode or the person below. An ask whose tool OpenCode did not
  name (one raised during a feed gap is the usual case) cannot be put to the
  policy, and goes to the person (rejected instead in a delegated session
  that may not grant approvals); ACP, given no tool name, skips the policy
  and lets a grant or the mode answer. Under full access OpenCode asks only
  where the agent's own rules say ask, and ACP's full-access launch
  configuration allows every action (`stationOpenCodeApprovalConfig`), so on
  both transports the policy sees only the asks OpenCode makes: parity, not a
  new gap.
- **Child sessions** inherit their parent's session rules
  (`core/src/session.ts`), so a child's ask is answered as the parent's would
  be, except that the deny check uses the child's own agent's rules
  (`GET /api/agent/{name}`; rules that cannot be read send the ask to a
  person). A child's own children are governed the same way, and a child that
  switches agent (`session.agent.selected`) has its later asks decided on the
  new agent's rules. `subagent` stays rejected under Ask and Auto, but a `subtask: true`
  command starts a child without that permission, and its asks are governed
  this way.
  "Allow for this session" is a grant the adapter holds, scoped to the asked
  patterns, and dropped when the mode changes.
- **Before a governed start**, the #3924 project-code scan runs, then Station
  reads the agent's rules and the saved approvals. It refuses the start if a
  saved allow would let a governed action run without asking. A governed
  session runs only `build` or `plan`.

On ACP, OpenCode 2.x supports host Never ask without a 1.x launch overlay.
Station answers the asks OpenCode makes and leaves its own denies and saved
approvals in force. Ask, Auto, and Never ask confined to Auto retain R1's
refusal because ACP does not expose the saved approvals needed to verify them.

## Managed policy (R5′)

`opencode` is not a managed-policy engine id. OpenCode, on either transport and
with the preview on or off, is governed by the policy's `acp` entry
(`managedPolicyEngineId` maps `opencode` to `acp`) and pinned by `instances.acp`.
`acpRegistryAgents: false` covers it the same way. The native path applies the
`acp` pin's binary and environment to `serve`. Pinned arguments belong to the
`acp` command line and are not given to `serve`.

Naming `opencode` in a policy is deferred. Whether a connection runs OpenCode is
read from its user-controlled id and command, so an `opencode` entry could be
bypassed and could not pin a binary. That waits for OpenCode to have a verified
identity, such as a pinned single-binary install.
[`opencode-identity-policy.test.ts`](../../src-server/providers/__tests__/opencode-identity-policy.test.ts)
covers that turning the preview on neither widens nor narrows a policy.

## Generic seams lifted

These changes widen shared abstractions instead of adding OpenCode-only
features:

- **Generic session actions.** The base branch owns
  `ProviderAdapterShape.rewindSession(threadId, turnId)`
  (`SessionRewindOutcome`), `sessionContinuity(threadId)`
  (`SessionLiveContinuity`) and `reconnectMcpServer`, with their routes. The
  OpenCode adapter answers them on both transports. Natively, rewind hides the
  named turn and every later one: it stages a revert at that turn's own user
  message, files included, commits it, and clears the revert if the commit
  fails. It refuses with the shared reasons (`not-live`, `turn-running`,
  `send-preparing`, `rewind-pending`, `unknown-turn`) before anything is sent,
  and reports the files the revert restored. `/rewind` with no turn named takes
  back the last turn. Native continuity is rewind in place and no fork. MCP
  reconnect is OpenCode's own disconnect then connect
  (`/api/experimental/mcp/{server}/…`); OpenCode 2 has no MCP sign-in Station
  can start. Over ACP the inner ACP adapter answers all three.
- **Engine-command dispatch.**
  [`engine-command-dispatch.ts`](../../src-server/providers/adapters/engine-command-dispatch.ts)
  decides once, for every adapter, what each route kind does: prompt text, an
  engine request, or an adapter action. ACP's `sendTurn` moved onto it with no
  behaviour change. Natively, `/compact` and `/rewind` are adapter actions, a
  listed OpenCode command runs as the engine's own command and keeps its
  output, and anything else is prompt text.
- **Steer-channel gating by declaration.** The ACP `_session/steering` channel
  is chosen by the handshake identity `initializeMetaFeature: 'steering'`
  (`_meta.steering.supported === true` on `initialize`), never by
  `agentInfo.name`. OpenCode 1.x names itself the same and keeps cancel and
  re-prompt. Only that channel's `{outcome: 'promptRequired'}` answer is read
  as a decline.
- **`listedInProviderInventory`.** An adapter behind an off preview leaves the
  provider inventory (`GET /api/orchestration/providers`).
- **`connectionBacking: 'acp-registry'`.** An adapter that runs saved ACP
  records reserves no connection id (#3355). It is not inspected or listed as
  an engine connection of its own, and it has no readiness of its own. The
  connection projection names it as the engine (`engineId` and `provider`) only
  while it claims the connection. Shared code asks `isAcpFamilyEngine` (`acp`,
  `opencode`) where a behaviour belongs to the ACP connection a session runs
  on.

## Deferred and accepted gaps

- **Credential-responder lift**: deferred, because there is no second
  implementer. The native client's route allowlist and never-allow list stand
  in for it ([engine credentials](engine-credential-provider.md)).
- **Server password**: visible to same-user `ps eww` in the server's
  environment. OpenCode removes it from its own tools' environment.
- **No replay on the SSE feed**: Station reconciles over REST after a
  reconnect, as described above.
- **Durability provider-branch gate**: `isAcpFamilyEngine`'s hard-coded list is
  invisible to the gate (`check-durability-provider-branches.mjs`), which
  matches provider literals.
- **Not done natively**: fork (the base has no generic fork action for it to
  answer; OpenCode's `POST /api/session/{id}/fork` is not in the route table),
  `/log` replay, and a managed single-binary install of OpenCode 2.x.
- **Code Mode `opencode.worktree_create`** asserts no permission, and it can
  run the project's configured `commands.start`. Station does not see it as an
  ask, so neither its rules nor an Agent's staged policy can stop it.
  Accepted for this preview.
- **A moved session's resume cursor** is written when the move is followed,
  but reaches Station's store only with the next `sendTurn` answer: the
  adapter shape has no seam to update a live session's cursor. A resume
  before then reads the stored session's directory from OpenCode, so it still
  starts where the session is.
- **The #4828 path list** does not include `.opencode/`. Below host full
  access an edit there goes to a person (the configuration-edit guard), but a
  grant-free full access session answers it.
- **The staged policy's tool description** is not given natively: OpenCode's
  ACP layer builds a title for its permission request, which the native ask
  does not carry, so an approval guardian sees the tool's name and input only.
- **OpenCode 1.x** stays ACP-only. **2.x over ACP** supports host Never ask;
  confined approval modes retain R1's refusal.
- **CI coverage of the real binary**:
  [`opencode-native.process.test.ts`](../../src-server/providers/__tests__/opencode-native.process.test.ts)
  drives a real 2.x server. It is skipped, with the reason in its title, unless
  `STATION_TEST_OPENCODE_2_BINARY` (or `PATH`) gives a verified version. CI has
  none, so CI runs the replay suites against the captured fixtures.
