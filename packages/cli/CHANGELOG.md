# @kontourai/station-cli

## 0.7.0

### Minor Changes

- 519f361: Extend chat contracts and SDK clients with bounded file and conversation references, streamed delivery metadata, tool-purpose projections, and owner-bound workspace checkpoint preview/restore. Add the corresponding CLI checkpoint commands and shared runtime projection fields while preserving existing event and authorization boundaries.
- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- 4206b09: Compose encrypted workspace import with existing authenticated Project creation and identity read-back. Retain imported bytes and a durable request when registration is uncertain, and document explicit target mapping and reconciliation.
- 7ef36cc: Add enrolled cloud target verification with stable boot observation, redirect refusal, bounded responses and no execution authority transfer.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.
  
  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- 4e39225: Add explicit operator-approved device binding to verified Tailscale person identity. Host pairing consent and the local access-approval CLI opt in without changing ordinary device grants, Project membership or wire scopes. Require server acknowledgment so older servers cannot silently approve device access as person binding.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.
- e5dfb04: Add an authenticated SDK and CLI workflow for setting or clearing portable Project execution roots.
- 3a64f5f: Expose portable Project identity export/preparation and explicit destination
  attachment through the CLI, reusing the public identity SDK and receiver validation.
- 687d586: Add explicit account-bound Device approval and guest-only Project view contracts.
  Expose validated Project view APIs while keeping personal full-configuration APIs
  separate. Require deliberate operator approval mode selection in the pairing UI
  and CLI, and retain current account and Project membership as independent access
  requirements. This is a view-only pilot; shared execution and complete guest
  onboarding retain their separate delivery requirements.
- 0c3d60e: Verify restored Git workspace contents through the bounded package codecs and emit a package-bound verification receipt. Check fresh local imports before target Project creation, preserving failed imports for explicit recovery and reporting platform limitations.

### Patch Changes

- 390ea80: Show the supported `--bind-person` option in environment access approval help without advertising it for denial.
- e4d61c8: Wake API initialization readers directly, bound diagnostic telemetry, and separate MCP transport construction from custody while preserving the published API.
  
  Align plugin preview component and conflict kinds with the emitted layout contract and share those types with server and UI producers.
  
  Canonicalize newly allocated temporary homes before admission so read-only source observation shares the writer home identity.
- d23831f: Add `station delegate wait <task-id>` — bounded, observation-only completion
  waiting for delegated tasks (#2264). It polls the canonical delegation status
  API until an honest outcome and never dispatches, restarts, approves, or
  interrupts the delegated provider. `--timeout=<seconds>` (default 3600, max
  86400) and `--interval=<seconds>` (default 5, max 3600) are validated before
  any request; each status read is bounded by the remaining wait budget.
  Outcomes are distinguishable via `data.outcome` and delegate-scoped exit
  codes: completed (0), failed/canceled (3), needs-action (4), wait deadline
  with the task still running (5), unknown status (6), observation lost (2),
  Ctrl-C (130). Under `--json` exactly one envelope is printed.
- f6f9497: Add a GCP development target to the shared read-only cloud preview, retaining explicit gaps for provisioning, credentials, and execution transfer. Document the isolated operator-run Compute Engine bootstrap.
- fa6338a: `station delegate status` renders an idle-only turn supervision (no declared
  total budget — Muse's default) as "Turn budget: none declared for this turn"
  plus its idle limit, instead of printing nothing.
- 5570767: Muse turns no longer have a default idle bound (#2269). `TurnSupervisionFacts.idleLimitMs` (contracts) and `DelegatedTaskTurnSupervision.idleLimitMs` (SDK) are now optional and present only when an idle bound was declared for the turn; a Muse turn with no declared bound publishes a declaration with neither `idleLimitMs` nor a total budget. Consumers that read `idleLimitMs` as an always-present number must handle its absence. `station delegate status` prints "Idle limit: none declared for this turn" for such a turn.
- d209461: Keep plugin builds from reinstalling a containing Station workspace. Root-managed
  plugins use the managed dependency bootstrap; standalone nested plugins install
  only into their own directory, preserving the host's lock and dependencies.
- 15a2761: Surface classified provider-plan quota failures in delegate status and
  events (#2265). `DelegatedTaskReason`/`DelegatedTaskEvent` carry the
  serving Station's re-validated bounded facts (plan window,
  provider-reported timezone-less reset text, qualified retry-after only
  when genuinely supplied); `station delegate status` (and `wait`'s summary)
  renders them beneath the fixed guidance line. No retry, model/provider
  switch, or paid fallback is added — the task stays failed and resumable.
- 09bd7e6: Add applied registry-policy and untrusted package-claim contracts, explicit Node signing/digest leaves, and root/dependency trust-review transport. Keep signer fingerprints distinct from publisher identity and preserve offline retained recovery.
  
  Release the fixed contracts/shared/SDK group together. Shared and CLI dependency floors must include the contracts release containing the new public leaves; unreleased same-version candidate tarballs require an explicit override throughout the consumer graph and do not prove npm availability.

## 0.6.0

### Minor Changes

- d926a67: Expose exact authorized terminal tool-result reads and identity-only Task Keep
  operations through typed clients and CLI commands. Protected reads validate
  Thread projections, withhold stale content, and preserve generic failure states.

## 0.5.0

### Minor Changes

- b118d6e: Command Station Slice B (#1984, #1986, #1991): the CLI now dispatches through a
  Commander program, `station [dir]` (in a TTY) lazily opens a running Station in
  the browser (finding it through the instance registry and the
  `GET /api/system/instance` probe) and offers inline / service / temp-home when
  none is running, `station service` (in a TTY) presents an interactive menu, and
  a one-time short-TTL local-bootstrap token lets that opener hand the local
  browser a paired credential through the URL fragment without any peer-address
  trust.
  
  Commander is bundled (a devDependency esbuild inlines into `dist/station.mjs`),
  not added to `dependencies`: the published tarball still carries only the
  audited `@napi-rs/keyring` runtime dependency (`bundle.test.ts`). The
  interactive menus use Node's built-in `readline/promises` rather than a new
  prompt dependency, so nothing new reaches the runtime install graph.

## 0.4.0

### Patch Changes

- Updated dependencies [2b01d6a]
  - @kontourai/station-shared@0.4.0
