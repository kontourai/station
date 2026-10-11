# @kontourai/station-shared

## 0.9.0

### Minor Changes

- 31cac46: `tool.started` and `tool.completed` carry an optional `toolKind`
  (`EngineToolKind`, the Agent Client Protocol `ToolKind` vocabulary) when the
  engine reported one, and the shared transcript projection copies it onto the
  tool part as `MessagePart.toolKind`. A tool part bound to a pending approval
  also carries `approvalToolName`, the tool name the request itself reported.
  `toolRequestGrantLabel` now reads "Allow for this session" when the request
  reported no tool name: what such a grant covers is decided per adapter or
  engine, so the label claims only the session scope.
- c2c67c2: Add optional Agent MCP composition and loading preferences, with exact per-server tool selections for external-engine delivery. Existing declarations retain their prior defaults.
  
  Expose the existing connection-quota contract through its public package subpath for CLI and shared consumer resolution.
- 2451a89: New `./display-text` subpath: the display form approval surfaces show
  untrusted text in. It provides:
  
  - `displayText` (invisible format characters removed, controls turned into
    spaces, one line), `displayLines`, `displayJoinedLines` and
    `displayMultilineText`;
  - `boundedJoinedLines` and `boundedDisplayText` (lines kept apart with " ⏎ ",
    "…" on a cut, and "(+N lines)" for lines a cut hides);
  - `compactDisplaySource`, `truncateDisplay` and `displayLength` (code points).
  
  Also a new `./display-reveal` subpath, kept apart so an entry bundle that
  only needs the display form does not carry it:
  
  - `revealHiddenCharacters`, `revealHiddenCharactersText`,
    `hasHiddenCharacters` and `hiddenCharacterToken`, for raw views that show a
    hidden character as a «U+XXXX» token instead of applying it.
  
  `toolRequestPreview` and `toolRequestDisplayName` now return that display
  form:
  
  - Bidi controls, zero-width and other invisible characters are removed, and
    C1 controls become spaces.
  - A multi-line value keeps its lines apart with " ⏎ " instead of a space.
  - Padding (runs of spaces, blank lines, invisible characters) no longer
    pushes later text past the cut.
  - A cut always ends in "…", followed by "(+N lines)" when whole lines are
    hidden.
  - Truncation is by code point.
- 53f9482: Say which requests a tool-level allowance may answer (#2933).
  `tool-request-preview` adds `toolRequestIsPlainCall`, true only for the `tool`
  and `edit-mode` session grants, and `toolRequestIsPlanExit`, which also treats
  an ACP `switch_mode` tool kind as a plan exit, and `toolRequestNeedsPerson`,
  true for a plan exit or a harness question (`AskUserQuestion`). `ToolRequestGrantInput` gains an
  optional `toolKind`, read from a payload's `toolKind`, and such a request offers
  no session grant. Station uses them so an agent's `tools.autoApprove` pattern
  never answers an escalation or a plan exit. On Claude Code and ACP a broad
  pattern therefore no longer covers escalations: a headless run that reaches one
  waits on an approval request, and a delegated child that cannot grant approvals
  is denied the call at once. An ACP plan exit answered "for this session" is
  sent as the agent's allow-once option, so its `allow_always` option (such as
  "yes, and auto-accept edits") is not reachable from a session answer.
- 31cac46: Add `ATTACHMENT_INPUT_UNSUPPORTED_CODE` for a send refused because the engine
  cannot take its attachments, `ComposerImageSupport.caveat` for an attach-time
  note when image support is unconfirmed (with the `modelSupportVaries` input),
  and `TurnStartedEvent.steerInterruptedRun` for a steer delivered by stopping the
  running step. The runtime event projection now splits a turn at a steer.
- d48225d: Treat Claude Code's known escalation signals as asks that always prompt
  (#2932). `ToolRequestGrantInput` gains optional `toolInput`, `decisionReason`,
  `suppressAlwaysAllowRule`, `defaultToNo` and `requiresUserInteraction`, and
  `toolRequestSessionGrantFromPayload` reads them from a `request.opened`
  payload. A request escalates, so neither a tool grant nor
  `toolRequestIsPlainCall` covers it, when its input sets
  `dangerouslyDisableSandbox: true`, its `decisionReason` is exactly
  `dangerouslyDisableSandbox`, `requiresUserInteraction` or the MCP organization
  ceiling, or any of the three flags is true. A `SandboxNetworkAccess` request,
  and one flagged `suppressAlwaysAllowRule`, offers no session grant. Bash safety
  checks and plain ask rules still carry no signal and are not covered.
  Agent SDK 0.3.278 forwards `suppressAlwaysAllowRule` and `defaultToNo`, so
  those two apply now; `requiresUserInteraction` applies once an SDK forwards it.
- c7a394e: Read Claude Code's structured ask reason when deciding what a tool-level
  allowance may answer (#2932). `tool-request-preview` adds `claudeAskEscalates`
  and the `ClaudeAskReason` type, `ToolRequestGrantInput` gains an optional
  `claudeAsk`, and `toolRequestSessionGrantFromPayload` reads it from a
  `request.opened` payload. A Claude ask escalates, so neither a tool grant nor
  `toolRequestIsPlainCall` covers it, when `classifierApprovable` or a
  `decisionReasonCode` is set; when its reason type is anything but `other` or
  `subcommandResults`; when type `other` carries any reason but `This command
  requires approval`; when a `subcommandResults` ask is not on Bash (every
  PowerShell ask) or carries a `matchedAskRule` or any `decisionReason` text;
  when a Bash or PowerShell ask carries no reason type; or when `claudeAsk` is
  present but is not an object (`null`: the engine's request was not read).
  Any other ask with no reason type, and a request with no `claudeAsk` at all
  (another engine), is judged as before. Station's Claude sessions therefore
  prompt for safety checks, ask rules on a single command, sensitive-file
  edits and every PowerShell ask, under a session grant and under an agent's
  `tools.autoApprove`. A chained Bash command with no safety check is still
  answered by a grant. When more than one part needs approval, an ask rule on
  the chain or on one of its parts, a write or delete outside the working
  directories in an `&&` or `;` chain or behind a pipeline's redirect, and a
  part's warning that is not a safety check are not visible on the engine's
  request, as before this change.
- f98bffd: Clients now state their client API protocol in `X-Station-Client-Protocol`
  (`CLIENT_PROTOCOL_HEADER`, parsed by `readClientProtocolHeader`). A host
  refuses a protocol below its advertised `minClientProtocol` with HTTP 426
  `client_protocol_unsupported` and a malformed header with 400
  `client_protocol_invalid`; an absent header reads as protocol 1. The SDK
  request seam sends the header where no CORS preflight can refuse it
  (`@kontourai/station-shared/client-protocol`).
- db816d2: Desktop sidecars and installed services now share one atomic host-owner claim. `claimHostOwner` replaces
  `claimDesktopSidecar` and refuses any other live Desktop sidecar or durable
  service on the home under one registry lock, reaping provably stale sidecar
  records and returning the winning owner. `station service install` reserves the home and records policy before backend
  startup, restoring the prior entry on backend failure. The service supervisor
  refuses missing policy or a live conflicting owner with a readable remedy,
  and stops Station if readiness publication fails. It takes the installer's
  reservation before starting Station. Desktop publishes its spawned child's
  PID/birth before Listening, retaining the fence while a live orphan shuts down.
  Direct server entrypoints remain unfenced; bare container `service run` now
  refuses missing policy and needs an explicit policy-registration lifecycle.
  `removeOwnedInstance` gains `removeWhenOwnerGone`.
- 24205de: Export `validateWorkspacePackagePaths` from `@kontourai/station-shared/workspace-package` so registry acquisition can reuse the workspace codec's portable filename and path collision validation.
- 301fc96: Add explicitly granted remote-access management, typed relay invitation controls, and bounded native account proof support for IAM-authorized access changes.
  
  Publish the native relay link codec through Shared, preserving the Connect compatibility export.
- c6c7d4d: A request left open by an aborted turn is settled instead of staying pending.
  `@kontourai/station-shared/request-settlement` exports
  `requestIdsSettledByTurnAbort`, the fold the server and the CLI both apply.
  `station approvals list` and `station operate` no longer offer such a request,
  `approvals list` rows carry `requestEventId`, and `approvals respond` and
  `operate` bind a decision to the request event they showed. The contracts
  change is documentation of `request.opened.turnId` and of what a
  `request.resolved` with status `cancelled` or `expired` means.
- fac321f: Add host-observed installed visual Skill experience identity and inventory contracts,
  and export the shared inert definition reader used by author builds and runtime inventory.
  Inventory availability follows exact package admission and current Skill precedence;
  this does not authorize execution or render a guided workflow.
- 6601a65: Add inert visual Skill experience declarations and a versioned authoring contract.
  Portable author builds validate referenced definitions and bundled Skill digests;
  installed experience execution and rendering use their separate plugin admission
  and canonical Session owners.
- 19aff2a: Add local Skill library inspection and revision-bound experience author review commands. Include a Station-curated attributed Matt Pocock engineering Agent Plugin example with portable dependency materialization and explicit workflow stops.
- fac321f: Add validated visual skill inventory/session clients and React Query hooks, plus source-bound foreground start preflight and shared inert input parsers. Validate with the canonical wire reader only after a successful feature response. `sendExecutionMessageWithInventory` runs the start preflight with a caller-supplied inventory reader. Provide the opt-in workspace-pane producer for host-bound reads, canonical question answers and unsent stage preparation with pinned invocation preconditions.

### Patch Changes

- 306ebf4: Add optional `clientInputId` to turn steering and an explicit indeterminate
  result so acknowledgement retries preserve one engine invocation. Add a
  per-device Return preference. Preserve nonterminal retry errors in the runtime
  transcript projection instead of treating them as failed turns.
- 2d235b6: Publish retained-source statistics and measurement coverage types, conservative observation allocation, and authority-scoped station operator usage queries. Keep unknown attribution and measurements explicit.
  
  Expose separate station-usage-query and usage-rollup-query entries so lazy usage views can avoid startup analytics coupling while preserving existing root exports.
- 112beed: Add optional durable source sequence to usage receipts. Reconcile sparse cumulative observations in source order and transfer deduplicated logical receipts within the aggregate bound.
- 67f8927: Follow literal Skill calls in bundled references outside the entry Skill directory.
  Called Skills and their bytes participate in dependency inspection and source
  review, while missing calls remain named gaps and reference cycles stay bounded.
- Updated dependencies [31cac46]
- Updated dependencies [c2c67c2]
- Updated dependencies [7899c97]
- Updated dependencies [31cac46]
- Updated dependencies [300a272]
- Updated dependencies [c95a288]
- Updated dependencies [f98bffd]
- Updated dependencies [bda5e88]
- Updated dependencies [306ebf4]
- Updated dependencies [b406f8d]
- Updated dependencies [b586e3c]
- Updated dependencies [fa8ac09]
- Updated dependencies [ee12b92]
- Updated dependencies [22171b1]
- Updated dependencies [fc181b4]
- Updated dependencies [fc181b4]
- Updated dependencies [a91c50d]
- Updated dependencies [3b001e5]
- Updated dependencies [e7fb9b3]
- Updated dependencies [d4fbcaf]
- Updated dependencies [ee12b92]
- Updated dependencies [9def13d]
- Updated dependencies [c965c37]
- Updated dependencies [eee7f74]
- Updated dependencies [8396b7b]
- Updated dependencies [91ec8af]
- Updated dependencies [91ec8af]
- Updated dependencies [d3e3396]
- Updated dependencies [84fb656]
- Updated dependencies [3accc1b]
- Updated dependencies [1d17ddf]
- Updated dependencies [35e8916]
- Updated dependencies [301fc96]
- Updated dependencies [8e17752]
- Updated dependencies [1aecbf3]
- Updated dependencies [c6c7d4d]
- Updated dependencies [cf099c6]
- Updated dependencies [4bbc4ce]
- Updated dependencies [2d235b6]
- Updated dependencies [21f4fbc]
- Updated dependencies [8f66f37]
- Updated dependencies [f75829f]
- Updated dependencies [a097632]
- Updated dependencies [112beed]
- Updated dependencies [fac321f]
- Updated dependencies [fac321f]
- Updated dependencies [6601a65]
  - @kontourai/station-contracts@0.9.0

## 0.8.0

### Minor Changes

- d326e74: Add the React-free `@kontourai/station-sdk/agent` authoring and execution entry point, reusing canonical Station client operations. Keep plug-in UI on existing exports and document how a plug-in distributes an Agent that headless callers can execute.
- 3ab0959: Let a client check for and apply an update to a Station installed from a
  prebuilt release archive. The update status reports the `archive` and
  `archive-service` install kinds with the running and newest verified release,
  and a launcher-run service's update progress (`ServiceUpdateProgress`), read
  with `requestServiceUpdateProgress` or `useServiceUpdateProgressQuery`. The
  shared package adds `prebuilt-archive` and `service-launcher-protocol`
  subpaths for the archive and service-launcher facts the CLI and server share.
- 519f361: Extend chat contracts and SDK clients with bounded file and conversation references, streamed delivery metadata, tool-purpose projections, and owner-bound workspace checkpoint preview/restore. Add the corresponding CLI checkpoint commands and shared runtime projection fields while preserving existing event and authorization boundaries.
- ae258f0: Say what an approval's "for this session" answer grants (#2915, #2916).
  `tool-request-preview` adds `toolRequestSessionGrant` and
  `toolRequestSessionGrantFromPayload`, which compute a
  `ToolRequestSessionGrant` (`tool`, `edit-mode`, `read-folder`, `folder` or
  `none`) from a request's tool name, suggestions, blocked path and matched ask
  rule, and from the engine's permission mode (a file edit in `plan` or
  `bypassPermissions` offers none). It also adds
  `sessionGrantPermissionUpdates`, which returns the suggestions each grant
  forwards, and `directoryPermissionUpdateKind`.
  `toolRequestGrantLabel(toolName, grant)` now takes the grant as a required
  second argument and returns `undefined` when no session grant is offered.
  Callers that passed only a tool name must compute the grant first. The
  conversation `MessagePart` gains an optional `approvalSessionGrant`, set by
  the runtime event projection on a part bound to an open request.
- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- 8d785cf: Add a versioned transport-only Station connection binding and maintained-JOSE
  signing/one-shot verification helpers. These proofs bind an independently
  approved signing key to one client challenge, enrollment generation, certificate
  pair and exact connection descriptions; they do not grant application access.
- 96290b2: Add the Device-local connection trust record and public-key validation helpers
  for independent approval, generation-checked rotation and retained revocation.
  These describe endpoint trust only and grant no account or Project access.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.

  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- ad2f0d3: Add the Muse background-work codes: `MUSE_LINGERING_CHILD_REAPED_CODE` and `MUSE_HELD_TURN_UNFINISHED_CODE` (`runtime.warning` codes for a held Muse turn's unreported background work), and `MUSE_TURN_SLOT_RELEASING_CODE` (a retryable send refusal while the previous Muse process is still exiting). Document that an adapter may suspend a turn's declared `idleLimitMs`.

  The runtime-event projection now reconciles `turn.completed.outputText` against ALL text the turn emitted, as the live chat path already does: an equal text adds nothing, and a strict extension appends only the missing suffix. This changes how reloaded transcripts render for more than Muse, in each case to match what the live view showed:

  - Muse, Codex and station-agent turns whose `outputText` is the whole turn's text no longer repeat the text written before a tool (or across several tool segments) in the final paragraph.
  - Turns with reasoning between text segments (thinking-interleaved Claude) no longer repeat the text before the reasoning.
  - When `outputText` extends the streamed text only by a trailing suffix (a coincidental prefix, text reported only at the terminal, or a trailing newline), that suffix is now appended rather than dropped.

  Turns whose `outputText` is only the final answer (Claude without interleaved reasoning) render as before.
- 0a73a73: `observePluginTreeAsync` can also report, from the same walk, the digest of a
  tree with some named entries left out. `PluginInstallConsent` gains an optional
  `gitMetadata: 'excluded'`, echoing a preview that staged the source without its
  git metadata so the install stages it the same way.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.
- 9c5c353: Remove `outcomeFirstAllQuietHeadline` from `@kontourai/station-shared/notification-priority`. No Station surface read it; callers that composed an all-quiet headline should inline the two strings.
- 09bd7e6: Add applied registry-policy and untrusted package-claim contracts, explicit Node signing/digest leaves, and root/dependency trust-review transport. Keep signer fingerprints distinct from publisher identity and preserve offline retained recovery.

  Release the fixed contracts/shared/SDK group together. Shared and CLI dependency floors must include the contracts release containing the new public leaves; unreleased same-version candidate tarballs require an explicit override throughout the consumer graph and do not prove npm availability.
- 08370b2: Resolve Windows PowerShell by its System32 path for process-birth probes, give the
  lock's own-process lookup the Windows cold-start budget, and name the failed probe
  in lock errors. Removes `resolveProcessBirthFingerprint` (`./lifecycle-events`) and
  `WINDOWS_OWN_PROCESS_BIRTH_ATTEMPTS` (`./process-identity`), which nothing used;
  `ownProcessBirthProbeSchedule` now owns the retry schedule.
- 0c3d60e: Verify restored Git workspace contents through the bounded package codecs and emit a package-bound verification receipt. Check fresh local imports before target Project creation, preserving failed imports for explicit recovery and reporting platform limitations.

### Patch Changes

- b8417e5: Add bounded newest-first conversation history hydration and recover complete terminal text from a retained suffix. Expose full saved Station addresses and host-owned native profile editing without forwarding credentials to a changed origin.
- e4d61c8: Wake API initialization readers directly, bound diagnostic telemetry, and separate MCP transport construction from custody while preserving the published API.

  Align plugin preview component and conflict kinds with the emitted layout contract and share those types with server and UI producers.

  Canonicalize newly allocated temporary homes before admission so read-only source observation shares the writer home identity.
- d0ca944: Correct CLI help for supported option syntax, distribution boundaries, request
  deadlines, and checkpoint limitations. Update package documentation and examples
  to match current exports, hook signatures, build paths, and authorization limits.
  These documentation changes do not implement the separately tracked runtime fixes.
- f6f9497: Add a GCP development target to the shared read-only cloud preview, retaining explicit gaps for provisioning, credentials, and execution transfer. Document the isolated operator-run Compute Engine bootstrap.
- d209461: Keep plugin builds from reinstalling a containing Station workspace. Root-managed
  plugins use the managed dependency bootstrap; standalone nested plugins install
  only into their own directory, preserving the host's lock and dependencies.
- ae8f5d4: Resolve PowerShell 7 at its standard install path (`%ProgramFiles%\PowerShell\7\pwsh.exe`)
  before PATH for the own-process birth probe's retry, so a cold Windows PowerShell start
  on a minimal PATH no longer leaves the retry with nothing to launch.
- ae8f5d4: Run every Windows current-user ACL command through one shared runner with one
  120-second budget, sized for a cold or saturated host. The server's local-grant
  secret used 30 seconds and timed out on a loaded Windows runner; the CLI's profile
  store and triage storage had no bound at all. `station start` now fails as soon
  as the server process exits during startup instead of waiting out its readiness
  deadline.
- Updated dependencies [4f19d35]
- Updated dependencies [3ab0959]
- Updated dependencies [74af29e]
- Updated dependencies [058376c]
- Updated dependencies [e172b3d]
- Updated dependencies [519f361]
- Updated dependencies [4aca094]
- Updated dependencies [7ef36cc]
- Updated dependencies [e4d61c8]
- Updated dependencies [8d785cf]
- Updated dependencies [32f4251]
- Updated dependencies [797b975]
- Updated dependencies [a8bbc67]
- Updated dependencies [31278d5]
- Updated dependencies [c3bf345]
- Updated dependencies [96290b2]
- Updated dependencies [d0ca944]
- Updated dependencies [e1af43c]
- Updated dependencies [debc0ee]
- Updated dependencies [5f54657]
- Updated dependencies [716480e]
- Updated dependencies [1344781]
- Updated dependencies [c3474f5]
- Updated dependencies [eb1fd17]
- Updated dependencies [ad2f0d3]
- Updated dependencies [fa6338a]
- Updated dependencies [5570767]
- Updated dependencies [84031dd]
- Updated dependencies [2f941ba]
- Updated dependencies [4e39225]
- Updated dependencies [984f9bc]
- Updated dependencies [a777b37]
- Updated dependencies [272c29b]
- Updated dependencies [17c17a1]
- Updated dependencies [ce6ec59]
- Updated dependencies [4d38391]
- Updated dependencies [e5dfb04]
- Updated dependencies [eb6363d]
- Updated dependencies [6e9c63e]
- Updated dependencies [f287e75]
- Updated dependencies [44c019b]
- Updated dependencies [b6331e9]
- Updated dependencies [687d586]
- Updated dependencies [a2c21d7]
- Updated dependencies [0d75052]
- Updated dependencies [9ccd6e4]
- Updated dependencies [a30cab6]
- Updated dependencies [a30cab6]
- Updated dependencies [a30cab6]
- Updated dependencies [a30cab6]
- Updated dependencies [be60151]
- Updated dependencies [a30cab6]
- Updated dependencies [09bd7e6]
- Updated dependencies [0c3d60e]
  - @kontourai/station-contracts@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [1fc735a]
- Updated dependencies [5cb0aaa]
- Updated dependencies [3f6b3c2]
  - @kontourai/station-contracts@0.7.0

## 0.6.0

### Patch Changes

- 4dfc08a: Expose declared provider prompt-cache inclusivity and cache-aware total helpers, which distinguish absent cache measurements from reported zeroes and refuse unverified sums.
- 6905e5f: Publish the bounded, cache-authority-aware usage receipt rollup fold.
- Updated dependencies [6456e42]
- Updated dependencies [a04a5f1]
- Updated dependencies [4dfc08a]
- Updated dependencies [214eb24]
- Updated dependencies [8680665]
- Updated dependencies [f37bdbb]
- Updated dependencies [3be50bb]
- Updated dependencies [0704b6b]
- Updated dependencies [3af06aa]
- Updated dependencies [6905e5f]
  - @kontourai/station-contracts@0.6.0

## 0.5.0

### Patch Changes

- 0602467: Portable integration exports now explicitly distinguish ordinary legacy
  credentials, which `--include-secrets` writes as plaintext, from secret-binding
  references and binding-backed credentials, which never export.
- 737e343: `build`: load esbuild lazily, and stop assuming a `packages/` directory exists.

  `buildPlugin` now resolves esbuild through `await import('esbuild')` at the top
  of a layout-plugin build instead of a module-level static import, and reports a
  named, actionable error when it is absent. Nothing about the exported API
  changes — `buildPlugin` was always async — but consumers that only ever read
  config or parse manifests no longer pull esbuild's per-platform native binary
  (~9.9 MB unpacked) into their load path or their install. `@kontourai/station-cli`
  uses this to declare esbuild as an optional peer dependency.

  `buildAllowedInputRoots` also stops falling back to a
  `<package>/../packages/shared` path that `resolveWorkspacePackageRoot` has
  already rejected. Inside the monorepo the fallback never fired; outside it — a
  bundled CLI, where `shared` is inlined and no `packages/` directory exists — it
  fired every time and `realpathSync` threw `ENOENT`, so plugin builds were
  impossible from an installed package. A root that is not on disk allows
  nothing, so the containment set narrows rather than widens.
- Updated dependencies [fd9a422]
- Updated dependencies [051d372]
- Updated dependencies [62c5c0d]
- Updated dependencies [278bf3b]
  - @kontourai/station-contracts@0.5.0

## 0.4.0

### Minor Changes

- 2b01d6a: Align @kontourai/station-shared version with @kontourai/station-sdk and @kontourai/station-cli
