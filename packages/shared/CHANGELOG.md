# @kontourai/station-shared

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
