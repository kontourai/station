# Module map

For the high-level reading path, start with the [system overview](../architecture.md)
or [interactive learning atlas](../learn/README.md). This catalog owns the module
explanations used by both the reader and the shipped Station Docs MCP.

This is the contributor map for code that changes behaviour across a seam. Read it before restructuring a caller family. It records the Interface a caller and a test may use, where concrete Adapter choice happens, and the old shapes that must not return.

## Shared language

| Term | Meaning in Station |
| --- | --- |
| **Module** | Anything with an Interface and an Implementation: a function, class, package, or tier-spanning slice. |
| **Interface** | Everything a caller must know: type shape, ordering, invariants, error modes, configuration, and performance. It is also the test surface. |
| **Implementation** | Code inside a Module. An Implementation may have private seams without widening the caller Interface. |
| **Seam** | The place where a Module's Interface lives and behaviour can change without editing its callers. |
| **Adapter** | A concrete thing that satisfies an Interface at a Seam. It names a role, not how much code it contains. |
| **Depth** | How much useful behaviour an Interface offers compared with what callers must understand. A deeper Module hides more implementation detail behind a small, clear contract. |

Prefer an intent-shaped Interface over storage-shaped operations. Compose required Adapters at an external Seam; do not construct hidden dependencies, export raw storage keys, or mutate a Module with post-construction setters. A second real Adapter proves a seam; a hypothetical alternative does not.

## Index

| Module | Intent | Primary source |
| --- | --- | --- |
| [VirtualApplicationIngress](#virtualapplicationingress) | Dispatch encrypted connector requests into ordinary application authorization without socket or cookie authority. | `src-server/services/connections/virtual-application.ts` |
| [DeploymentAuthentication](#deploymentauthentication) | Resolve operator-configured account identity independently of device and Project authorization. | `src-server/services/identity/deployment-authentication-service.ts` |
| [StationControlDispatchScope](#stationcontroldispatchscope) | Resolve server-owned dispatch targets for the shared Station-control scope rule. | `src-server/runtime/mcp/station-control-dispatch-scope.ts` |
| [SessionMessageDelivery](#sessionmessagedelivery) | Put one message into another Session once: start a turn, steer the running one, or answer busy. | `src-server/services/orchestration/session-message-delivery.ts` |
| [SessionDigest](#sessiondigest) | Account for a Session's turns from recorded events alone, in pages that never exceed a byte cap. | `src-server/services/orchestration/session-digest.ts` |
| [DestinationRegistry](#destinationregistry) | Project one immutable destination inventory into routing, navigation, commands, and badges. | `src-ui/src/app-shell/destination-registry.ts` |
| [Keyboard shortcuts](#keyboard-shortcuts) | Register actions, resolve local bindings, and dispatch only under current input and modal conditions. | `src-ui/src/contexts/KeyboardShortcutsContext.tsx` |
| [UnifiedSearchService](#unifiedsearchservice) | Aggregate bounded owner-qualified search pages without flattening authorization or source truth. | `src-server/services/search/unified-search-service.ts` |
| [WorkspacePaneHostContributions](#workspacepanehostcontributions) | Bind package-level Pane-host actions and explicit Agent selection without treating Pane requirements as routing authority. | `src-server/services/plugins/workspace-pane-host-contributions.ts` |
| [WorkspacePaneHostAdmission](#workspacepanehostadmission) | Admit one captured package action at the existing foreground invocation boundary. | `src-server/services/plugins/workspace-pane-host-admission.ts` |
| [InstalledPluginInventory](#installedplugininventory) | Keep valid and rejected installed plugin directories visible from one filesystem-backed inventory. | `src-server/services/plugins/installed-plugin-inventory.ts` |
| [PackageMcpAdmissionJournal](#packagemcpadmissionjournal) | Retain package-incarnation admission evidence without inventing destructive retirement authority. | `src-server/services/plugins/package-mcp-admission.ts` |
| [DesktopStartupReadiness](#desktopstartupreadiness) | Admit the main desktop window only after an exact sidecar identity ticket commits. | `src-desktop/src/startup_readiness.rs` |
| [NativeRelayGrantRenewalSupervisor](#nativerelaygrantrenewalsupervisor) | Maintain existing saved-route grants while a native renderer is visible, without granting new trust or application access. | `src-ui/src/platform/native/nativeRelayGrantRenewalSupervisor.ts` |
| [Native relay enrollment](#native-relay-enrollment) | Enroll one explicitly approved Device without exposing its credential to the WebView. | `src-desktop/src/native_enrollment_host.rs` |
| [Native relay link intake](#native-relay-link-intake) | Review untrusted routing intent and keep bound invitation secrets in native custody. | `src-desktop/src/native_relay_link_intake.rs` |
| [Native relay account and requests](#native-relay-account-and-requests) | Compose selected Device transport with separate person sessions and bounded member reads. | `src-ui/src/platform/native/nativeRelayConnectionOwner.ts` |
| [NativeApplicationSignaling](#nativeapplicationsignaling) | Own a native peer transcript and one bounded Device request proof for the opt-in application transport. | `src-desktop/src/native_application_peer.rs` |
| [PendingPairingCompletion](#pendingpairingcompletion) | Complete one accepted device-pairing request once, with shared subscribers and bounded retry. | `packages/connect/src/core/pendingPairingCompletion.ts` |
| [SessionQueryModule](#sessionquerymodule) | Authorize and project one conversation from one ordered event stream. | `src-server/services/orchestration/session-query-module.ts` |
| [ConversationSessionLineage](#conversationsessionlineage) | Establish and inspect durable conversation-to-execution-session lineage. | `src-server/services/orchestration/conversation-session-lineage.ts` |
| [SessionCommandModule](#sessioncommandmodule) | Execute the closed session-command vocabulary and return an outcome with explicit receipt certainty. | `src-server/services/orchestration/session-command-module.ts` |
| [SessionLifecycleModule](#sessionlifecyclemodule) | Mutate one session lifecycle without racing provider turn startup. | `src-server/services/orchestration/session-lifecycle-module.ts` |
| [SessionTurnBoundaryAuthority](#sessionturnboundaryauthority) | Persist the one-way provider invocation boundary that lifecycle completion must not cross. | `src-server/services/orchestration/session-turn-boundary.ts` |
| [TurnDeduplicator](#turndeduplicator) | Give exactly one owner the right to create a client turn. | `src-server/services/orchestration/turn-deduplicator.ts` |
| [AdoptionLedger](#adoptionledger) | Own attached-session adoption reservation, legal transitions, and atomic commit. | `src-server/services/orchestration/adoption-ledger.ts` |
| [RecoveryLedger and private CredentialApplicationFactory/Handle](#recoveryledger-and-private-credentialapplicationfactoryhandle) | Persist recovery dispatch truth and exact credential-application settlement. | `src-server/services/orchestration/recovery-ledger.ts` |
| [CredentialRecoveryModule](#credentialrecoverymodule) | Sequence profile staging, replay, settlement, and compensation. | `src-server/services/orchestration/credential-recovery-module.ts` |
| [ConnectionInspector](#connectioninspector) | Return one bounded, provenance-aware connection inventory. | `src-server/services/connections/connection-inspector.ts` |
| [SecretBindingAdministration and IntegrationSecretResolver](#secretbindingadministration-and-integrationsecretresolver) | Keep binding metadata authority separate from one child-establishment materialization capability. | `src-server/services/secrets/secret-binding-administration.ts` |
| [ExtensionNotificationBindings](#extensionnotificationbindings) | Bind exact observed extension tuples to functional consumers without promoting vendor semantics. | `src-shared/extension-notification-bindings.ts` |
| [JsonFileMutationAuthority](#jsonfilemutationauthority) | Serialize bounded JSON read/derive/publish work without blocking the server event loop. | `src-server/domain/file-storage-helpers.ts` |
| [LocalSkillMutationAuthority and SetupImportEffectJournal](#localskillmutationauthority-and-setupimporteffectjournal) | Serialize every local Skill mutation and retain each reviewed import effect through recovery. | `src-server/services/agents/skill-service.ts`, `src-server/services/setup/existing-agent-setup-import.ts` |
| [SkillExperienceRuntime](#skillexperienceruntime) | Admit one pinned Skill selection at canonical turn boundaries and project immutable Session presentation history. | `src-server/services/orchestration/skill-experience-runtime.ts` |
| [AgentPluginLoader](#agentpluginloader) | Consume one installed Agent Plugins package without copying portable components or widening failure boundaries. | `src-server/services/plugins/agent-plugin-loader.ts` |
| [StationHomeArchive](#stationhomearchive) | Validate, back up, and atomically restore one inactive Station home. | `packages/shared/src/station-home-archive.ts` |
| [StationHomeRecoveryPreflight](#stationhomerecoverypreflight) | Observe bounded recovery metadata without granting mutation or execution authority. | `packages/shared/src/station-home-recovery-preflight.ts` |
| [ProjectFileTransactions](#projectfiletransactions) | Serialize Project lifecycle and nested record mutations under exact revision capabilities. | `src-server/domain/project-file-transactions.ts` |
| [ProjectIdentity](#projectidentity) | Prepare and attach portable identity while preserving receiver-local Project identity. | `src-server/services/projects/project-identity-service.ts` |
| [StationKnowledgeMcpServer](#stationknowledgemcpserver) | Serve scoped read/capture tools separately from platform controls. | `src-server/tools/station-knowledge-mcp-server.ts` |
| [KnowledgeStoreProvider](#knowledgestoreprovider) | Register canonical roots and resolve their record adapters. | `src-server/knowledge-store/knowledge-store-provider.ts` |
| [SqliteVecIndexProvider](#sqlitevecindexprovider) | Rebuild and query derived root partitions with explicit freshness limits. | `src-server/knowledge-index/sqlite-vec-index-provider.ts` |
| [Workspace checkpoints](#workspace-checkpoints) | Capture turn-associated file snapshots and restore one through current workspace and caller checks. | `src-server/services/checkpoints/checkpoint-restore.ts` |
| [Personal Work Board](#personal-work-board) | Arrange exact work references without copying their owners' state. | `src-server/services/spatial-board/spatial-board-store.ts` |
| [BrowserSessionService](#browsersessionservice) | Own browser acquisition, profile-scoped sessions and authorized automation independently of viewers. | `src-server/services/browser/browser-service.ts` |
| [Shared live surface](#shared-live-surface) | Fan out current frames and arbitrate input through producer-owned authorization and a fenced lease. | `src-server/services/live-surface/registry.ts` |
| [KnowledgeFileTransactions](#knowledgefiletransactions) | Publish one multi-file knowledge mutation with durable rollback and exact conflict detection. | `src-server/knowledge-store/adapters/shared/file-transactions.ts` |
| [SharedWorkingState](#sharedworkingstate) | Converge one authorized text document through versioned causal operations and bounded resync. | `src-server/domain/shared-working-state.ts` |
| [LiveWorkSession](#liveworksession) | Project bounded, separately authorized ephemeral work presence for one exact Project/Task/surface/session. | `src-server/domain/live-work-session.ts` |
| [ProjectTaskRoom](#projecttaskroom) | Present one Task's shared text document, presence, and cursors through the server-owned task room. | `src-server/services/orchestration/project-task-room-runtime.ts` |
| [SharedWorkingStateEditingCapability](#sharedworkingstateeditingcapability) | Plan exact text-edit operation batches from #2889 atom snapshots and prove preview/operation identity. | `src-server/domain/shared-working-state-editing.ts` |
| [RevisionEvidenceModule](#revisionevidencemodule) | Freeze immutable shared-state revisions and resolve Station-local evidence references. | `src-server/domain/revision-bound-evidence.ts` |
| [ActionOperationModule](#actionoperationmodule) | Retain one authorized platform mutation's reconnect-safe execution status without owning its domain lifecycle. | `src-server/services/operations/action-operation-service.ts` |
| [OperationalEventOutbox](#operationaleventoutbox) | Persist validated operational facts before isolated notification and expose bounded replay truth. | `src-server/services/operational-events/operational-event-outbox.ts` |
| [OperationalEventDelivery](#operationaleventdelivery) | Claim, settle, retry, and dead-letter one scope-filtered operational fact without duplicate effects. | `src-server/services/operational-events/operational-event-delivery.ts` |
| [OperationalEventSubscriptions](#operationaleventsubscriptions) | Authorize declarative subscribers and isolate projected at-least-once delivery. | `src-server/services/operational-events/operational-event-subscriptions.ts` |
| [LearningReviewProjection](#learningreviewprojection) | Present an owner-issued learning lifecycle without adopting learning authority. | `packages/contracts/src/learning-review.ts` |
| [KnowledgeSourceObservation](#knowledgesourceobservation) | Observe one registered canonical record without bootstrap, repair, or learning authority. | `src-server/knowledge-store/knowledge-store-provider.ts` |
| [PluginCompositionModule](#plugincompositionmodule) | Stage and atomically activate scoped, reversible plugin capability graphs. | `src-server/services/plugins/plugin-composition.ts` |
| [PluginGrantReconciliation](#plugingrantreconciliation) | Converge runtime capability generations after a durable plugin grant change. | `src-server/services/plugins/plugin-grant-reconciliation.ts` |
| [PluginCommandEffects](#plugincommandeffects) | Admit plugin palette effects for browser documents, one per request, and report withdrawals honestly until each captured effect settles. | `src-server/services/plugins/plugin-command-effects.ts` |
| [RegistrySourceManager](#registrysourcemanager) | Persist connected catalogs and bind discovery, inspection and acquisition to the exact current source. | `src-server/providers/registries/registry-source-manager.ts` |
| [RegistrySupplyChainPolicy](#registrysupplychainpolicy) | Verify registry package signatures and prepare exact pins and rollback sources. | `src-server/services/plugins/registry-supply-chain.ts` |
| [ReviewEvidenceModule](#reviewevidencemodule) | Run independent read-only reviewers over one exact revision range and retain attributable findings without minting a verdict. | `src-server/services/evidence/review-evidence-module.ts` |
| [VerificationCoordinator](#verificationcoordinator) | Coordinate one provenance-bound verification request through admission, execution, and receipt publication. | `scripts/lib/verification-coordinator.mjs` |
| [RuntimeResourcePostureController](#runtimeresourceposturecontroller) | Report host CPU diagnostics without influencing product work. | `src-server/services/infra/resource-posture.ts` |
| [OutboundDispatchModule](#outbounddispatchmodule) | Queue and dispatch one offline message without replaying a possible provider effect. | `src-ui/src/lib/outboundQueue.ts` |
| [SchedulerLedger and BuiltinScheduler](#schedulerledger-and-builtinscheduler) | Own scheduled-job state, occurrence receipts, and safe unattended execution. | `src-server/services/scheduling/scheduler-ledger.ts` |
| [TaskDispatcher and TaskGraph](#taskdispatcher-and-taskgraph) | Dispatch a task while keeping graph state and orchestration detail local. | `src-server/services/projects/task-dispatcher.ts` |
| [StationInstanceReconciler](#stationinstancereconciler) | Observe and converge one installed Station instance safely. | `packages/cli/src/commands/station-instance-reconciler.ts` |

## DeploymentAuthentication

This boundary answers who signed in to a Station. Account identity augments Device and
Project authorization; it does not replace either. Follow the [authentication
service](../../src-server/services/identity/deployment-authentication-service.ts),
[application-session
service](../../src-server/services/identity/application-session-service.ts) and [HTTP
admission](../../src-server/runtime/bootstrap/runtime-http.ts).

`ApplicationSessionService` owns the proof-bound continuation store and current
provider-session/Device composition. `application-session-routes.ts` exposes its bounded
control surface, and `application-session-runtime.ts` installs it before request
admission. `account-response-guard.ts` rechecks delivery with zero prefetch. The SDK
application-session client owns key/proof construction; a relay only carries the
authenticated encrypted request/response stream. Provider hooks resolve private session
references; no virtual response installs a browser cookie.

Operator passkeys are a separate, enrollment-only owner so far (#3257). The
[enrollment service](../../src-server/services/identity/operator-passkey-enrollment.ts)
owns the confirm-by-code request and the single-use WebAuthn ceremony, and the
[registry](../../src-server/services/identity/operator-passkey-registry.ts) owns the
private SQLite file of public keys. The browser half is mounted on the consent
listener ([routes](../../src-server/runtime/consent/operator-passkey-enrollment-routes.ts));
the host half is the [operator-only route set](../../src-server/routes/operator-passkeys/operator-passkey-host-routes.ts)
behind `station environment operator passkeys`. Nothing authenticates with an
enrolled passkey yet.

The opt-in native continuation uses a separate protocol and headers. Its
challenge/exchange routes require server-owned provenance from an admitted
native application peer, an approved account-bound Device and provider session
verification. Missing browser `Origin` alone never selects native authority.
The [native Connect transport](../../packages/connect/src/core/nativeApplicationTransport.ts)
and [SDK client](../../packages/sdk/src/client/application-session-native.ts)
consume host-supplied trust and structured peer/account operations. The ordinary
selected native route now composes these owners for separate account sign-in,
invitation acceptance and bounded member reads. This source integration does not
establish physical iOS or released Nightly qualification.

The native [account-proof key owner](../../src-desktop/src/native_account_proof_key.rs)
is a separate foundation. It stores a software P-256 key through the existing
OS keyring adapter, under an account-proof namespace distinct from broker
routing keys. Its owner tuple names the app, channel, client instance, Station
and approved Device; validating that tuple's shape does not establish actual
Device approval. The separate [account operation owner](../../src-desktop/src/native_account_operations.rs)
registers bounded commands for public-key/challenge preparation, local
username/password exchange-body preparation, supported GET/HEAD account proofs,
and fixed invitation-acceptance and session-revocation bodies. The prepared
context exposes its actual host deadline; the SDK clamps the continuation's
usable expiry to that deadline and the server's expiry. It derives identity/hashes/JTI/time from the reconciled host owner,
fences handles/replay/expiry/key identity and exposes no raw signing input.
The SDK's typed proof-provider path validates and retains the ordered body before
the Device transport signs its complete bytes. Commands are registered on desktop
and mobile, and the ordinary selected-route owner uses them. OS-keyring software
custody does not establish hardware-backed non-exportability; physical iOS and
process-lifecycle qualification remain separate. Follow the
[native capability boundaries](../design/native-capabilities.md).

The [Device proof key vault](../../src-desktop/src/native_device_proof_key.rs)
uses a separate keyring namespace and adds the Device binding ID to its owner.
Both vaults share a [private custody core](../../src-desktop/src/native_proof_key_core.rs)
while preserving the account vault's stored format. The native
[candidate manager](../../src-desktop/src/native_device_binding_candidate.rs)
persists a provisional owner snapshot and binding ID in a separate private
Keychain namespace before it creates the Device proof key. The main-window
`station_native_device_binding_candidate` command joins the selected relay-route
profile to the separately host-authorized Device profile under one profile-store
snapshot; both must share its revision, client instance and exact Station
origin. Approved Station trust, route grant and surface come from the selected
route; the current paired Device comes from host authority. It returns only the
public JWK and thumbprint. Reauthorization resumes the same key while the
profile revision, Station, Device, trust, route and surface remain exact. The
command does not submit approval, reconcile a receipt, authorize a peer session
or sign a request; no renderer caller currently consumes it. The native Device
path also has a [binding sidecar](../../src-server/services/ssh/native-device-proof-binding-service.ts),
[JWS verifier](../../src-server/services/identity/native-device-proof-verifier.ts),
[replay store](../../src-server/services/identity/native-device-replay-store.ts)
and a separate credential-free Request principal. The
[native runtime factory](../../src-server/runtime/bootstrap/native-device-proof-runtime.ts)
composes server admission behind explicit opt-in and provider/native connector
checks. The [binding management routes](../../src-server/routes/system/native-device-proof-binding-routes.ts)
require current operator credentials and expose historical/current binding
readback. A separate [Device self-receipt route](../../src-server/routes/system/native-device-proof-self-receipt-routes.ts)
admits only the owning current ordinary Device bearer. The Desktop
`station_native_device_binding_self_receipt` command restores its existing
candidate and reads that fixed endpoint through the native HTTP owner. It
rechecks owners under the profile/authority locks before recording an
observation, distinguishes cached history from fresh readback, and retains the
key on unknown outcomes. The [peer owner](../../src-desktop/src/native_application_peer.rs)
and account operation owner require a positive observation scoped to the current
owner/epoch; cached history is not returned as fresh reconciliation.
Native proofs authorize only the pilot account and Project-read
surface, with independent account and membership checks. Host peer/Device and
account proof commands are registered, while ordinary native route selection,
actual IPC/packaged acceptance and fresh relay-only enrollment remain unqualified; the
[broker design](../design/connection-broker.md#native-device-proof-on-the-application-channel-2893)
owns their integration and acceptance requirements.

The separate [paired-Device custody owner](../../src-desktop/src/native_device_custody.rs)
captures authenticated pairing identity in an app/channel-bound keyring
companion and resolves it under current profile authority. Its retirement
journal permits cleanup retries without restoring credential authority.
See [native capability boundaries](../design/native-capabilities.md#desktop-paired-device-identity-custody)
for legacy, crash-recovery and platform qualification limits.

**Intent and Interface.** The public `deployment-authentication` contract lets an
operator supply a versioned authentication module at startup. Its factory receives the
selected Station identity, public origin, fixed authentication base path and private
state directory. It declares exact account cookies and operation paths; Project plugins
and requests cannot install an authority. Verified issuer/subject pairs produce bounded
stable principals; contact and display fields grant no access.

**Implementation and callers.** `deployment-authentication-loader.ts` validates explicit
startup configuration and storage custody. `DeploymentAuthenticationService` validates
provider results, bounds authentication and declared-operation response waits, rejects
expired/malformed credentials and keeps request identity through bounded-body
replacement. `runtime-http.ts` composes this before personal-device admission, while
`runtime-routes.ts` refuses conflicting verified people and supplies the actual account
principal to existing execution and room authority.
`deployment-authentication-routes.ts` owns the narrow login/self surface, its
origin/body/attempt bounds and declared-operation dispatch. Account authentication does
not bypass device scope or implement Project membership. The ten-second request
acceptance deadlines do not bound module import, provider startup or provider close, and
do not undo an external effect already invoked.

`local-account-runtime.ts` composes the built-in username/password provider, private
persistent signing authority and real Project enrollment eligibility.
`local-account-administration-routes.ts` exposes operator-only account disabling,
session revocation and recovery links. `ProjectMembershipService` holds the current
local Project revision while `ProjectMembershipStore` atomically manages scoped members,
invitation acceptance and ownership transfer. The SDK's `project-access`,
`local-accounts` and `account-authentication` subpaths serve the Project/admin controls
and the separate browser account entry. Account entry does not mount personal connection
providers or persisted Project caches.

**Evidence and limits.** External-module HTTP fixtures and the real runtime
principal-composition suite exercise refusal and identity propagation. They do not prove
a production identity provider, email delivery, visual design or physical two-human
acceptance. See [deployment authentication](../guides/deployment-authentication.md) for
the operator contract and the remaining account/member delivery boundaries.

### Optional local-account OIDC

`local-account-oidc.ts` reads bounded operator configuration and secret references. The
local account provider composes pinned Better Auth verification and server-controlled
invitation state with the private session/administration owners. The descriptor, SDK and
account entry view expose configured browser choices alongside passwords. A failed or
mismatched discovery response disables the external choice. A stalled discovery request
can instead delay all account startup; optional OIDC has no independent Station-owned
discovery deadline. The HTTP issuer fixture in `local-account-oidc.test.ts` exercises
identity and callback failures. It does not qualify a production issuer or Windows
custody.

## VirtualApplicationIngress

[VirtualApplicationIngress](../../src-server/services/connections/virtual-application.ts)
lets an admitted connector call the protected application without inventing a local
socket or bypassing its middleware.

**Intent and Interface.** A trusted connector receives the protected Station application
through `StationRuntimeOptions.virtualApplication` only after startup completes. Its
Fetch-compatible dispatcher and retirement signal do not supply account, Device or
Project authority. The canonical Station origin is fixed at composition time; the
connector supplies actual client Origin and the existing scoped credentials inside its
authenticated encrypted channel.

**Implementation and callers.** `services/connections/virtual-application.ts` under
`src-server` constructs fresh Requests, refuses cookie and proxy authority, limits open
response custody to 32 requests, and fences late or streaming delivery. Abort rejects
delivery; a handler that has not settled still occupies its request slot. This is not a
guarantee that its application effect stopped. `runtime/bootstrap/station-runtime.ts`
captures the already protected Hono app at route composition, publishes after
initialization, and retires it at replacement or shutdown. No Node socket metadata is
synthesized. See [protected application
dispatch](../design/connection-broker.md#protected-application-dispatch) for lifecycle,
limits and the remaining encrypted-path acceptance.

## RegistrySourceManager

[The source manager](../../src-server/providers/registries/registry-source-manager.ts)
composes the existing visible Skill/plugin providers with user-added local
Skill directories, public GitHub libraries and local/HTTPS Station manifests.
It persists source configuration and last successful bounded snapshots under
the Station home. [The configuration reader](../../src-server/providers/registries/registry-source-configuration.ts)
refuses corrupt/unsupported or nonregular files and bounds the file to 8 MiB
and retained snapshots to 32. [Installed-state projection](../../src-server/providers/registries/registry-catalog-installed-state.ts)
uses the current local inventory and source ownership aliases for live and
offline plugin rows. Manifest providers supply one fresh coherent observation
for rows, source locations and untrusted publisher claims. A snapshot is discovery evidence; source removal/disable and
plugin generation replacement/revocation are checked again before publication
and use. A revoked provider cannot publish its in-flight result or fall back to
its previously cached rows. Plugin-owned Skill catalogs also use the route's
existing caller visibility projection, before inspection/acquisition reads.
Installed-name/conflict projection also withholds provided plugin Skills from
callers who cannot see the owning legacy or portable Agent Plugin.

[Registry routes](../../src-server/routes/plugins/registry.ts) expose source
management and source-qualified catalog tuples. The marketplace retains an
inspected selection through filtering/refresh, preserves equal names, names
partial/stale sources and returns installed content to the existing Library.
[SkillService](../../src-server/services/agents/skill-service.ts) sends exactly
one selected provider through the existing staging/publication owner, records
its reviewed source/catalog revision and observed package digest, and stages
updates before replacing the installed tree. Plugin acquisition retains the
ordinary preview/consent/installer, raw publisher-signed item ID, source key and
applied trust policy; host source IDs cannot authenticate a publisher.

The public shapes and provider interfaces are in
[`catalog`](../../packages/contracts/src/catalog.ts). SDK source actions
invalidate the existing Registry query family. Route tests exercise source
collision, unavailable sources, revision changes, retained installed packages,
signed acquisition, caller projection and provider revocation; UI tests cover
source actions and retained selection. These are local behavioral evidence,
not hosted marketplace, native device, release or arbitrary private-source
qualification. Other index formats and credential-bearing URLs are refused.

## Registry trust policy decisions

[Registry trust policy](../../src-server/services/plugins/registry-trust-policy.ts) owns
bounded policy identity and EventStore compare-and-set decision publication.
`registryTrust` in AppConfig is only candidate configuration; the existing applied
startup/reload owner publishes its epoch after successful configuration construction and
rechecks the candidate under the existing mutation authority. Observations use
`observeAppConfigFile` without initialization or migration. The journal stores SPKI
fingerprints, not PEM keys. The applied decision, acquisition receipt, and local
admission fences are described in [Applied registry trust
policy](../design/registry-trust-policy.md).

## SkillExperienceRuntime

[SkillExperienceRuntime](../../src-server/services/orchestration/skill-experience-runtime.ts)
binds explicit foreground selections to the installed source owner and the
canonical Session turn. The package-content lease/journal and Skill scope owner
revalidate pinned source/dependencies; source admission wraps actual send, steer
and accepting request effects. The existing exact turn attribution mechanism
adds only the bounded retained-snapshot reference to an accepted `turn.started`.

[Immutable snapshots](../../src-server/services/orchestration/skill-experience-snapshots.ts)
live in the same EventStore. Bounded history follows the existing conversation
lineage and Session read authorization. A snapshot without a canonical turn is
not invocation truth; removed sources retain inert history and fail future
admission. Rich pane actions additionally bind the exact current event and hold
the current `agents.invoke` grant. Presentation controls and package-defined
transitions create no second execution lifecycle.

The [contract guide](../reference/skill-experiences.md) links author/schema,
foreground routes, storage and the independent rich example. Controlled route,
provider-bound and frame transport evidence lives in
`src-server/routes/agents/__tests__/skill-experiences.routes.test.ts`,
`src-ui/src/__tests__/framePaneHost.test.tsx` and
`packages/sdk/src/__tests__/skill-experience-pane.test.ts`. Those tests do not
establish a live model, native-device renderer or release receipt.

## AgentPluginLoader

[AgentPluginLoader](../../src-server/services/plugins/agent-plugin-loader.ts) reads
portable package components in place. It is distinct from installation, permission
grants and provider/server-module activation.

**Intent and Interface.** `AgentPluginLoader` selects only locally vendored Agent
Plugins 1.0 schemas, reports component failures, and projects read-only Skill sources
and live ToolDefs from installed package bytes. Manifest-only parsing is shared with
public author builds through `packages/shared/src/agent-plugin-manifest.ts`; it has no
home/data provisioning side effects. Its generated standalone validators retain vendored
schema hashes and are checked by `scripts/agent-plugin-validators-gate.mjs`. Runtime
component discovery remains with this loader. `ConfigLoader` accepts that projection
through its read-only integration-source Interface; Station-owned files retain collision
precedence. Package ToolDefs remain definition-read-only: probes may return ephemeral
health, while mutations refuse until an owner-bound overlay exists, so no Station
integration snapshot can mask an updated or uninstalled package.

**Contract.** Fatal manifest failures discover nothing. Retired Station root fields
`layout`/`layouts` are fatal; other unknown root fields and a non-object `extensions`
value are reported and ignored. Only `io.kontourai.station` is validated. An
object-valued `extensions` map still requires every namespace member to be an object,
without inspecting unknown namespace contents. Vendored schemas resolve from the source
or bundled module asset tree and immutable compiled validators are shared across reads.
Skill, MCP-document, MCP-entry, and unsupported-transport failures remain isolated at
their specified boundary. Every recognized package root is excluded from legacy
recursive Skill discovery, even when the package fails fatally or none of its portable
Skills validate. Unreadable Skill enumeration is isolated to that component. Recognized
packages never enter the legacy `prompts` or copied-`integrations` contribution paths,
and the shared hidden-content manifest scan runs before format dispatch. Stdio path and
environment projection owns containment, default cwd, single-pass placeholders, and
persistent plugin data. Streamable HTTP owns URL and literal-header validation and
refuses redirects so package headers cannot cross origins. No portable component is
copied into a Station integration or Skill directory.

**Seam, Implementation, callers, and tests.** Runtime bootstrap composes the loader into
`SkillService` and `ConfigLoader`; the shared MCP transport consumes the projected cwd
and headers.
The Skill routes also expose an inert installed experience inventory. The loader
uses the existing content lease, yielding digest reads and admission journal to
bind validated definitions to an exact package incarnation/materialization;
SkillService applies the current discovered Skill precedence. Neither that
snapshot nor author capability requirements authorize execution. The controlled
route proof is `src-server/routes/agents/__tests__/skill-experiences.routes.test.ts`.
Directory/git install validates recognized packages through the same loader
while the legacy parser remains an explicit #346 fallback. Behavioral and
real-child-process evidence lives in `agent-plugin-loader.test.ts`,
`plugin-install-transaction.test.ts`, and `mcp-v2.test.ts`. **Do not reintroduce:**
recursive Agent Plugin Skill discovery, copied MCP snapshots, schema fetching,
whole-plugin failure for an invalid Skill/server, or placeholder expansion in
commands/URLs/headers.

## DestinationRegistry

**Intent and Interface.** `createDestinationRegistry(definitions)` composes one
immutable destination inventory. Callers read registered destinations, advertised
destinations for an explicit flag set, ordered sidebar, Customize-navigation or
command-palette projections, exact root routes, and the destination owning a
`NavigationView`. Labels and badges resolve when projected, after locale, branding, and
live attention facts exist. The built-in application composition is
`APP_DESTINATION_REGISTRY`.

**Contract.** Composition rejects empty or duplicate IDs, non-absolute routes, duplicate
exact-route owners, duplicate management-view owners, and duplicate sidebar or palette
order slots. Customize rows have unique order within each group and cannot also be
sidebar entries or hidden from navigation. Composition and filtering do not invoke
labels or badges; Customize projection resolves its optional label/route overrides. A
flag-gated surface stays registered and routable while `getAdvertised` hides it.
Developer advertisement uses the device-scoped `device:developer-tools` flag; other
flags can come from server previews. `hiddenFromNav` removes the sidebar affordance;
route, palette, badge, and header callers remain independent projections. Parameterized
Project, layout, Task, Agent, connection, and Workspace Pane routes retain their domain
parsers. Dynamic Workspace Panes use their typed availability catalog and join the
palette after static destination projection.

**Seam, Implementation, callers, and tests.** The UI shell composes built-in
descriptors. `routing.ts` consumes exact routes and semantic management ownership;
`ProjectSidebarNav`, `CustomizeDialog`, `CommandPalette`, and notification header badge consume their
ordered projections. Icons are a presentation Adapter keyed by the registry's finite
icon vocabulary. Future trusted plugin surface contributions must enter at registry
composition and pass the same validation; there is no mutable global `register()`
operation or renderer callback in persisted plugin data. Contract coverage is
`src-ui/src/app-shell/__tests__/destination-registry.test.ts` plus sidebar, palette,
routing, and header suites. **Do not reintroduce:** component-local static destination
arrays, route-to-sidebar switch statements, hard-coded badge copy outside the registry,
mutable post-construction registration, or treating a contributed renderer declaration
as navigation authority.

## Keyboard shortcuts

**Interface and owner.** [KeyboardShortcutsContext](../../src-ui/src/contexts/KeyboardShortcutsContext.tsx)
owns registered handlers, priority, conditional dispatch and local binding
overrides. `useKeyboardShortcuts` exposes registration/binding actions;
`useShortcutRegistry` subscribes readers such as the settings list and palette.
Registration must not re-render registering components into a loop. A replaced
handler's identity and registry order remain observable even when its display
metadata is unchanged.

**Persistence and dispatch.** [Shortcut preferences](../../src-ui/src/settings/shortcutPreferences.ts)
use the [device store](../../src-ui/src/lib/device-settings-store.ts), separately
for ordinary overrides and command skills. [Settings import/export](../../src-ui/src/views/settings/utils.ts)
carries those values. Dispatch checks disabled state, the registered `when`
expression and modal/input ownership before matching a chord; priority wins,
then registry order. Browser or OS interception remains outside that matcher.

**Caller limits.** The [editor](../../src-ui/src/views/settings/KeyboardShortcutsSection.tsx)
uses ID-derived context hints rather than the actual dispatch rule, and checks
the first matching enabled binding when offering replacement. Its captured
Space spelling also differs from the standard event key. The
[user guide](../guides/keyboard-shortcuts.md) explains current behavior and links
[#2767](https://github.com/kontourai/station/issues/2767) and
[#2771](https://github.com/kontourai/station/issues/2771) for those corrections.

**Evidence.** [Editor tests](../../src-ui/src/__tests__/KeyboardShortcutsSection.test.tsx)
and [registry tests](../../src-ui/src/__tests__/KeyboardShortcutsContext.test.ts)
exercise DOM events and synthetic handlers. The independent Space probe enters
through the mounted editor and provider; it does not qualify physical keyboards
or native-shell interception. Keep the modal-guard and registration-loop
regression rationale when changing this owner.

## UnifiedSearchService

**Intent and Interface.** `UnifiedSearchService.search(request, signal)` asks
one to eight immutable typed Providers for independently authorized pages and
returns a versioned result envelope whose key includes provider and semantic
owner identity. Results retain kind, exact scope, matched fields, currentness,
and a typed open intent that must be re-resolved by
its owner before navigation.

**Contract.** Query, provider, result, string, count, byte, continuation, and
result-acceptance deadlines are fixed by the host. Elapsed monotonic checks
reject late results even when synchronous work prevents the timer from firing.
This in-process aggregator cannot preempt synchronous provider callbacks and
does not establish a server responsiveness bound. The production Task and
transcript providers use the isolated read owners described below; arbitrary
providers do not inherit that isolation. Returning a Promise alone would not
establish it.
Provider output is cloned and validated;
unknown shapes, duplicate identities, excessive pages, throwing accessors,
timeouts, and exceptions become source-level unavailable state without error
detail. Restricted sources return no results or resource counts. A partial,
stale, restricted, or unavailable source never erases authorized results from
another source, and ranking uses provider relevance only—not trust or inferred
correlation. Same-text ids from different Station/tenant/Console owners cannot
collide. Provider continuations are wrapped by the host and bind provider
owner/version, normalized query, and exact filters. Providers are composed over
request-bound read authority, but the aggregate result does not invent a host
authorization receipt; navigation must re-resolve current authority. Console
projection is a contract owner only: Station has no sibling
store reader, and cross-product results remain blocked on a published Console
Adapter.

**Seam, Implementation, callers, and tests.** Public shapes live in
`@kontourai/station-contracts/unified-search`; server composition and validation
live in `src-server/services/search/unified-search-service.ts`. Initial local
Adapters map the existing authority-filtered Session message index and the
personal-mode TaskGraph list. The Task Adapter is deliberately not eligible for
hosted composition until a tenant-bound Task store exists. The runtime/API/SDK
slice below adds read-only transport and the palette's separate Workspace-search
mode. File scans, output/receipt providers, and a published Console adapter are
not part of this composition. Focused behavioral evidence lives in
`src-server/services/search/__tests__/`. **Do not reintroduce:** a universal
resource graph, sibling-repository scraping, provider-supplied owner stamping,
unauthorized hit/count projection, cached-snippet authority, inferred identity,
unbounded fan-out, or a second command-palette registry.

The current Task and message providers return bounded result windows and do
not issue search-page continuations; they reject a provider continuation if
one is supplied. The generic aggregator's continuation support is a separate
contract from the inspector's content-bound message pagination.

**Task-only isolation prerequisite (#1413).** `TaskGraphService.createPersonalSearchReader(stationId)`
binds one explicit-lifecycle reader to that owner's canonical file. Its fixed
worker operation reuses TaskGraph validation, ordering, and JsonFileStore's
missing-primary `.previous` recovery; corrupt primary data never falls back.
The worker accepts files up to 8 MiB (with a bounded one-byte overflow probe;
oversize is unavailable, not empty), scans the
existing bounded Task window, and transfers only a bounded provider page.
One request may execute per reader; there is no queue. The runtime warms both
workers at composition and awaits the readers needed by each operation before
starting its read deadlines. Readiness is bounded by the worker's own deadline;
a cold or replacement worker can therefore add wait time outside the read
budget. Deadline/cancellation fences result acceptance and retains the
exact worker until exit/termination is confirmed. An uncertain or rejected
cleanup occupies the slot; `inspect()` reports retiring/incomplete and bounded
`close()` reports winding-down/incomplete. Repeated close joins pending cleanup
and retries only settled rejection. The owner must close the reader. This is
trusted first-party CPU isolation, not a hostile-plugin security sandbox, and
is not a host-wide pool or a new authorization authority. Do not allocate one
reader per request. Runtime composition below owns the caller; supported-platform
responsiveness qualification remains open. Existing arbitrary Provider callbacks remain in-process and do
not acquire an isolation guarantee from this Task-only slice.

**Transcript read/auth isolation (#1413).** `OrchestrationService.createIsolatedTranscriptSearch()`
is the explicit-lifecycle composition seam used by the runtime owner.
Runtime initialization/recovery must precede query admission; it is not hidden
inside the request deadline. Canonical FTS ranking/scope terms and owner SQL
live in `transcript-search-queries.ts`, reused by EventStore and a read-only
worker. The worker never constructs EventStore, migrates a database, or receives
a branded SessionReadAuthority. Missing databases/schema and oversized read
facts are unavailable, never empty/ownerless success. Candidate content is
bounded before leaving SQLite; only excerpts/identities cross the worker port.
The existing single SessionAuthorization applies the same personal/hosted/
legacy policy with async cold owner lookups and positive-only caching. Its
generation fence invalidates in-flight lookups on owner/tenant changes. Parent
principal currentness and the generation are rechecked before publication.

**Owner-backed exact open reads (#1363).** The same Task reader now supports a
fresh personal-only Task/project point read, and the same transcript reader
supports exact Session metadata and indexed-message event point reads. Hosted
Task authority is rejected before worker admission. Transcript owner/tenant and
optional project filtering happen in SQL before the search limit; parent
SessionAuthorization, principal currentness, cancellation and runtime generation
still gate returned facts. Indexed messages carry an exact `matchedEventId`
separately from the legacy `messageId` navigation anchor, which multiple events
in one turn may share. Unified hit identity uses the exact event when present;
old providers' navigation-anchor API remains compatible. New message opens
require an exact Session/event pair, verify the canonical event still exists,
and never follow lineage to a newer child. Typed open locators are not cached
authorization receipts. These methods reuse one reader slot and its retained
cleanup, with no new worker per call or synchronous fallback.
The complete query plus authorization sequence has one two-second acceptance
deadline, one active query and no queue. Task and transcript workers share
private termination custody, not a plugin execution framework. EventStore
close reports pending/unavailable while its read worker remains outstanding;
Orchestration shutdown also fences and settles its reader. Native SQLite work
may defer thread termination until its native call returns; uncertain cleanup
retains the occupied slot and is never reported complete. This is CPU isolation
for fixed first-party reads, not a sandbox or a hard-real-time/preemption claim.
**Runtime/API/SDK slice (#1363).** `StationRuntime.configureRoutes` constructs
one `RuntimeSearch` after initialized Orchestration is published. It uses the
existing handshake `environmentId` as result `stationId`, without inventing a
machine/logical-Station identity. Request-bound lightweight adapters reuse one
Task owner and one Orchestration transcript owner; hosted Task search is
restricted and never invokes its worker. `POST /api/search` and
`POST /api/search/resolve-open` use closed 12 KiB bodies and the same
`orchestration:read` pairing scope as existing Task GET routes. No owner or
authority fields are accepted. The ingress-derived SessionReadAuthority,
request abort and live principal scope are checked before and after owner I/O.
Responses are private/no-store. Search/read outcome telemetry contains only
bounded operation/state labels, never queries or resource identities.
Shutdown fences admission synchronously before initialization/configuration
drains, keeps the Task close capability when retirement remains pending, and
leaves transcript shutdown to Orchestration/EventStore. SDK cached hooks require
the existing API-base/authority-epoch request scope and hide cached snippets
until a fresh successful read. Real owner+Hono tests live in
`services/search/__tests__/runtime-search.test.ts`; mounted SDK tests cover
same-origin epoch replacement. The palette caller is described below. Additional
source kinds and supported-platform responsiveness qualification remain deferred.

The SDK root publishes hooks/query keys only; direct operations stay on the
existing React-free `/client` entry. Hooks load that client lazily after
capturing request/scope, recheck cancellation, and use the existing live
credential-authority guard. This avoids introducing a shared search chunk
into the first-paint dependency table while retaining the full typed API.

Search routes bind the same exact ingress principal and home-possession fact
as conversation reads, not the server's OS display alias. A streaming bounded
validator preserves the authenticated Request object and its WeakMap bindings.
The single SessionAuthorization owner derives at most one legacy owner bridge,
only for a personal local-operator authority with home possession; SQL groups
the canonical/legacy owner postings before tenant/project/content filters and
the result limit. Paired, WhoIs, hosted, and remote-operator-only authorities
cannot claim the bridge. Final parent authorization still checks each result.
Failed initialization synchronously fences the captured runtime search, then
retains both retirement capabilities until actual closed proof. EventStore can
release only that identical closed source, never pending/replaced/closing
storage. Retry constructs a fresh Orchestration reader; old wrappers and old
async authorizers remain stopped and cannot borrow its worker. No broad provider
shutdown or source replacement is inferred from a failed search cleanup.

**Exact-message inspector (#1436).** The palette has an explicit local
Workspace-search mode, separate from existing command/remote-message search;
the inactive search mode sends no queries. A lazy read-only inspector consumes
`POST /api/search/read-message` through the public SDK with captured authority.
The same isolated transcript owner selects prompt/output text from the exact
canonical event, bounded in SQL before JavaScript materialization. Search-index
text is never a displayed-message authority. Content-bound pages preserve the
Session/event and reject mutation, deletion and authority loss. An optional
assigned Agent identity is projected only from recorded owner metadata. No
ChatDock current-conversation resolution, default Agent, second index or worker
is introduced. Task navigation passes existing unsaved guards, then performs a
fresh exact-open read and a final synchronous currentness check before the
canonical route commit. The managed-browser exact-message proof and focused
owner/SDK/UI tests are the evidence route for this tracer; broader source and
platform qualification remains separate. The runtime warmup regression suite
is `services/search/__tests__/runtime-search-worker-warmup.test.ts`; it tests
worker ownership, cold-start readiness and shutdown rather than a production
latency guarantee.

## WorkspacePaneHostContributions

**Intent and Interface.** `createWorkspacePaneHostContribution()` binds one versioned
package-level contribution to an exact plugin installation generation and Project. It
projects host-level prompt actions plus explicit available/default Agent state and
dispatches only an owner-qualified action key. Pane-local actions remain on their
descriptor; a host action is declared once and is never duplicated across every Pane.

**Contract.** An `own-plugin-agent` declaration carries only a clean Agent id; the host
adds plugin and installation-generation identity and re-resolves that exact ownership
before every launch. A `station-agent` is explicit and still passes Project availability
policy. Every action Agent and default must appear in the declaration's available set.
`requiredAgents` remains only a Pane availability requirement and is not accepted as
action or selection authority. Projection and dispatch recheck installation authority
around awaited Agent resolution, and a resolver that returns a different owner,
generation, or Agent is unavailable. Legacy migration is deterministic and read-only:
exact `<plugin>:<clean-agent>` spellings become owner-relative references and
`globalSkills[].prompt` remains literal prompt data. Legacy `prompt` actions require
manual review because the old path ambiguously used both `data` and `label`; another
namespace, an external/internal action, or an action with no explicit/default Agent
likewise returns `manual-review` rather than inventing routing.

**Seam, Implementation, callers, and tests.** Public data shapes live in
`@kontourai/station-contracts/workspace-pane-host-contribution`; validation,
deterministic legacy projection, owner/Agent resolution, and prompt-launch dispatch live
in `src-server/services/plugins/workspace-pane-host-contributions.ts`. The injected
prototype dispatcher is not production admission. WorkspacePaneHostAdmission below
supplies the real invocation guard; WorkspacePaneHostActions composes its production
route, SDK, host UI and example semantic migration under #1372. Focused tests execute
dispatch through the bound launcher and prove owner retirement, identity equivocation,
namespaced migration, and refusal without an Agent. **Do not reintroduce:**
first-required-Agent selection, punctuation-based owner inference beyond exact legacy
migration, ambient default Agent fallback, duplicated global actions, caller-provided
plugin ownership, navigation URLs in prompt intents, or persisted Layout rewrites.

## WorkspacePaneHostAdmission

**Intent and Interface.** `createWorkspacePaneHostAdmission()` prepares one installed
package's inert `workspacePaneHost` action for an exact Project, then lends one
server-only invocation capability to the existing foreground execution owner. It
captures the installation journal incarnation and selected physical artifact digest,
explicit own-plugin clean Agent identity/ownership marker, Project revision, authored
Agent spec and exact literal or registered prompt body. Legacy direct installations
retain explicit compatibility. Preparation is not activation or permission to execute;
the capability is one-shot and valid only inside its installation lease.

**Contract.** Admission linearizes at the irreversible provider invocation, not when its
Promise later settles. The existing plugin-content full-effect lease is acquired outside
Session coordination. At the final start call, and before the existing turn
`beginInvocation`/provider call, the Project revision read guard precedes the short
Agent identity guard. These guards recheck the exact Project, Agent bytes/owner,
installation digest and body binding, then synchronously invoke and return a boxed
Promise; Project/Agent locks release before network settlement. The identity lock never
spans an awaited provider operation. Reentrant installed-content changes are checked
again, not hidden by the outer lease. After invocation, existing receipts retain
accepted/pending/unknown effect truth; policy change cannot turn that into cancellation
or permission to replay. Captured Agent, Project, credential, presentation and
stall-window inputs are passed through the existing resolver rather than rereading
ambient replacements.

**Seam, Implementation, callers, and tests.** `ProjectFileTransactions` owns the
additive exact-revision read guard; `capturePluginAgentInvocation` reuses the canonical
Agent parser and identity mutation lock; installation and admission share one
plugin-Agent marker parser. Prompt-file discovery remains the in-place command-skill
source with bounded invocation reads. `OrchestrationService` and the existing foreground
tool adapter accept the server-only capability, never public JSON. The production
WorkspacePaneHostActions bridge below adds the route, SDK and host UI caller, with a
separate grant admission and one-shot delivery ticket. Its controlled-provider tests
exercise actual Session commands, turn invocation and EventStore receipt/event readback,
including pending-resolution and final-boundary races. Native execution carries a
private companion through the existing authorized-turn relay and repeats captured
admission at the native model-call boundary. Worktree provisioning enters the canonical
execution owner through a guarded phase and mints a private exact Session/Project/CWD
binding; start cannot use a pending, cross-Session, or different-directory binding.
Explicit non-plugin Agent references remain unavailable; none silently substitutes
another execution path. This is not Agent Plugins namespace activation or migration
completion. **Do not reintroduce:** a content lock acquired inside Session coordination,
a network await while holding the Agent identity lock, label/colon inference for
registered prompts, mutable captured snapshots, first-required-Agent defaults, raw
database authority or an automatic retry after possible invocation.

## PackageMcpAdmissionJournal

[The admission journal](../../src-server/services/plugins/package-mcp-admission.ts)
remembers selected package generations and whether an MCP effect may have started. Its
records constrain later admission; they are not proof that a process tree or remote
effect has stopped.

**Intent and Interface.** EventStore composes one journal on its existing SQLite handle.
Host installation observations mint exact incarnation identities; `reserve` retains a
pre-effect claim, `enterEffectBoundary` is one-way, and `requestRetirement` fences new
admission for that package. The returned claim alone may release a proved never-started
reservation. SDK settlement retains possible effects, and foreign, crashed or PID-reused
owners are never pruned.

**Contract.** The active journal bounds generations and claims; settled effects and
retired empty generations move into separate SQLite history tables. That compaction is
not a bounded total-history or safe-deletion guarantee. Corrupt or oversized metadata
and uncertain commit acknowledgement fail closed. No filesystem path, integration
definition or secret is duplicated. `inspectMutationImpact` reports positive recorded
history or unclassified/unavailable, never a negative safety proof. Every inspection
says `mutationAllowed: false`: compatibility and native/descendant/remote terminal
proofs are absent. No destructive permit API exists. This is shared control-plane
evidence, not a supervisor or sandbox.

**Seam and tests.** EventStore owns schema/open/transaction lifetime and exposes the
memoized journal before later runtime service composition. `PluginInstallationService`
composes asynchronous installation-state and materialization backends; the local
implementation reuses this journal. Portable loader definitions carry captured admission
into existing MCP custody, and portable install/remove routes publish or withdraw
generation selection while retaining old code and the independent data scope. Two real
EventStore processes in `package-mcp-admission.test.ts` cover concurrent
reservation/fencing, owner crash, exact no-effect release, same-content incarnation ABA,
commit uncertainty and fixed-capacity refusal. See [MCP UI
host](../design/mcp-ui-host.md#shared-package-admission-evidence-control-plane-prerequisite).
**Do not reintroduce:** new database opens, bare SDK-close drain receipts,
dead-parent/TTL release, declaration absence as historical proof, or a mutable caller
flag that upgrades this evidence into package deletion authority.

Public executable readers use `capturePluginRuntimeArtifact()` in
`src-server/services/plugins/plugin-runtime-artifact.ts`: the local installation adapter
supplies the selected physical root and admission state, and the reader checks its fresh
content digest. Pending activation cannot supply manifests, bundles, or server imports.
Public routes retain the captured artifact through module acquisition and recheck
currentness and grants before plugin callbacks; bundle delivery checks currentness again
after the asynchronous read. The runtime helper has no activation bypass and no
independent persisted state. `plugin-runtime-readiness.test.ts` exercises the real
journal and HTTP routes across pending/ready selection, content mutation, and stale
caller declarations. Operational subscription discovery unions journal-selected
identities with legacy inventory, binds each observer to the captured generation and
digest, and rechecks before dispatch. Reviewed-source resolution carries the same
capture through owner module reads and the final contribution publication. Neither
background reader accepts the installer's private pending-activation composition
capability. Ordinary provider boot also passes ready captured manifests to the existing
provider resolver, carries the physical artifact into preparation, and checks
grants/currentness before construction and at registry publication. An object exported
before a failed post-import check is disposed through the existing provider owner; a
refused factory is not run. Registry entries retain a separate ordinary readiness guard
and explicit activation-view predicate. Ordinary getters hide pending entries; a view
expires with its issuing activation owner. Returned methods recheck that same authority,
including previously captured method references. The existing retirement owner can still
call cleanup methods after revocation. A failed replacement keeps registry ownership
unchanged but does not leave changed source bytes callable through an older handle.

Inert installation discovery is separate from invocation capture:
`plugin-catalog-installation.ts` may project a validated pending declaration with typed
readiness, while executable readers still require ready admission. Plugin inventory
finishes awaited Git metadata reads before its synchronous current-selection projection.
Distribution catalogs discover journal-selected identities without aliases and preserve
disabled pending Panes with an explicit availability reason. The UI does not fetch
pending bundles, and recovery uses the SDK's fresh-preview consent flow. Post-ready
events refresh Project Pane and host-action queries as well as plugin inventory; they do
not authorize retries.

## InstalledPluginInventory

[The inventory scanner](../../src-server/services/plugins/installed-plugin-inventory.ts)
keeps broken installations visible so a user can repair them. It does not make a
directory name into a validated plugin identity.

**Intent and Interface.** `scanInstalledPluginInventory()` freshly scans installed
directories and local managed aliases in deterministic order. A readable valid manifest
returns its parsed manifest; a missing, unreadable, unsafe, malformed, or invalid
manifest returns a rejected entry naming only the directory plus a bounded path-free
reason and recovery instruction. Rejections are not persisted in a second registry.

**Contract.** The scanner reuses the canonical manifest loader, including its Agent
Plugins dispatch when that loader is present. Hidden staging directories remain absent.
Malformed JSON never echoes source bytes, and filesystem diagnostics never reach the
collection response. Missing-manifest and manifest-read/validation rejections emit a
structured warning through the supplied logger. A failure resolving a managed alias
currently returns a rejected row without that warning; collection visibility and logging
are separate. Provider resolution and Registry installed-state consume only valid scan
entries, while `GET /api/plugins` projects both valid and rejected entries. A rejected
directory has no trustworthy plugin version, permissions, bundle, settings, update, or
removal claim. The Plugins surface therefore gives it a distinct selection identity,
renders the exact rejection and repair instruction, and offers only the existing Reload
plugins recovery action.

**Seam, Implementation, callers, and tests.** The canonical collection route, provider
resolver, and JSON manifest registry share this scanner; the SDK validates the
rejected-row union and the existing Plugins view renders it. Unit tests cover
classification, secret/path suppression, fresh repair recovery, logger routing, SDK
validation, view-model reload ordering, and visible detail controls.
`tests/plugin-rejection-visibility.spec.ts` is the managed-browser repair/reload
acceptance route; unit tests do not establish that browser journey. **Do not
reintroduce:** catch-and-continue inventory loss, `console.debug` rejection reporting, a
persisted rejection cache, a fake version, valid-plugin controls on a rejected row, raw
JSON parse snippets, filesystem paths, or treating a directory name as validated plugin
identity.

## DesktopStartupReadiness

**Purpose.** The [pure readiness transition](../../src-desktop/src/startup_readiness.rs)
keeps a packaged desktop window from revealing application content before two
facts agree: the native host has proved the current sidecar identity, and the
main WebView has committed its React mount. The ticket binds generation,
instance ID, child boot ID and API base. A native page-start callback permits
identity proof but is not proof that the renderer mounted.

**Identity and reveal.** [Tauri composition](../../src-desktop/src/lib.rs) owns
the current ticket, credential-bearing profile selected for the exact channel
home, OS-held credential and authenticated `/api/system/identity` check.
It rereads profile binding after network I/O and the supervisor ticket before
commit. Renderer-selected profiles and historical `setupSource` do not authorize
this bundled-startup proof. Native page/ticket callbacks request the proof;
the [eager React liveness sibling](../../src-ui/src/platform/native/rendererLiveness.tsx)
reports only mount through `useLayoutEffect`, outside `PlatformBootstrap`.
StrictMode/remounts share one module-owned attempt. The host retains early
page/mount facts until DesktopServerState exists and replays them in order.

While waiting on macOS, the host can show a native startup cover. The WebView
stays alive at zero opacity, and the temporary accessibility hierarchy exposes
the cover rather than hidden application content. Reveal removes the cover,
restores opacity and normal AppKit accessibility children, then focuses that
same WebView. Merely hiding the WebView or copying a reveal-time accessibility
snapshot would change those guarantees.

**Recovery.** Server loss invalidates a pending identity proof without erasing
an already mounted renderer. A new main page invalidates its pre-ready mount
without inventing server loss. Proof is single-flight; a relevant profile write
can wake a bounded retry while waiting. Timeout produces one diagnostic per
epoch. Retry starts a new epoch: with a current owned ticket it first reprobes
without restarting; a later retry or missing ticket restarts only the owned
sidecar. A service-owned/unowned backend uses recovery-surface recommit instead
of signaling a durable service. Dev has an explicit bypass. Activation waits
for the appropriate state, and startup readiness does not re-hide a window
already admitted as ready.

The status bridge projects sidecar generation/instance/boot identity and clears
child fields after loss; the generation-tagged stdout handshake remains a
separate admission check. No browser timer, automatic renderer polling, cache
reset or CSP weakening supplies readiness.

Pure Rust state/claim tests and
[startup wiring tests](../../scripts/__tests__/startup-readiness-static.test.ts)
cover the decision boundaries. They do not prove AppKit pixels, OS dialogs,
real IPC or packaged behavior. The [native verification guide](../guides/native-shell-verification.md)
and [recovery guide](../user/native-recovery.md) keep those platform checks
separate.


## NativeApplicationSignaling

Desktop clients need to exchange connection offers and answers through a broker
without exposing routing credentials to their renderer. The native shell's
[peer owner](../../src-desktop/src/native_application_peer.rs) uses the existing
[relay custody](../../src-desktop/src/native_relay_redemption.rs) and registers
prepare/open/read/sign/close commands in [lib.rs](../../src-desktop/src/lib.rs).
The existing binding command supplies public profile, surface and approved-trust
metadata. The retained diagnostic signaling path cannot mint peer proof authority.

**Interface and custody.** Prepare names a saved profile and exact revision;
the host derives current Device/binding/receipt, trust and grant and mints an
opaque handle and nonce. Open adds only the exact bounded offer SDP; read names
the handle. Rust verifies Station's signed nonce, connection identity, both SDP
digests and DTLS fingerprints before accepting the transcript. A verified
transcript does not establish browser DTLS connectivity or account authority.
Sign constructs one Device proof for an allowlisted method/path/query and bounded
body, using current host owners. No caller supplies claims, hashes, signing bytes,
keys, bearer or a fabricated connected assertion.

**Results and recovery.** The handle exists before network opening, so an
uncertain open is recovered by reading the same handle. Each peer admits one
proof; owner/epoch changes, stale transcripts, replay and expiry refuse. The
client may shorten a read deadline but cannot extend a prior one. Bounded handle
tracking retires failures, late completions, cancellation, close and expiry.

**Integration boundary.** The [native adapter](../../src-ui/src/platform/native/nativeApplicationSignalingBridge.ts)
and [Connect transport](../../packages/connect/src/core/nativeApplicationTransport.ts)
consume the host lifecycle. Browser RTC remains client-owned; Connect verifies
the Station proof before applying the answer, then adds the exact Device proof
through the post-open request hook. Independent structured account operations
prepare the complete account exchange body before that hook freezes/signs it.
These opt-in libraries do not select a default route, enroll a Device or bypass
server account/Project checks. The browser/Node diagnostic lab does not exercise
this Tauri interface. Source and service tests do not establish
executed IPC, native keyring behavior or a packaged/device journey. See the
[native command contract](../design/native-capabilities.md#desktop-application-signaling-commands).

## Native relay enrollment

The [host coordinator](../../src-desktop/src/native_enrollment_host.rs) owns one
profile-bound enrollment attempt, its OS journal, recipient key, exact Device
candidate and activation publication. The
[contract](../../packages/contracts/src/native-relay-enrollment.ts) exposes
public preparations and opaque operation handles. The
[UI controller](../../src-ui/src/platform/native/nativeRelayEnrollmentClient.ts)
and [wizard](../../src-ui/src/views/connections-hub/NativeRelayEnrollmentWizard.tsx)
use fixed host operations through a fresh verified encrypted peer. Network
cleanup does not cancel a staged or committed enrollment. Explicit cancellation
retires only the owned attempt. Recovery reads host state; an active transition
must pass the host's currentness lookup before accepting its profile revision.
Expired candidates can use a newer routing generation only for signed terminal
cleanup under the unchanged broker, Station, enrollment, installation and trust.
The original ceremony remains bound to its old generation; no active or staged
Device can use this exception.

The [Station service](../../src-server/services/identity/native-relay-enrollment-service.ts)
requires supported pending account verification and a real operator's approval
of the exact person/Device candidate. Signed, HPKE-encrypted delivery contains
the Device credential only. Activation grants neither an account continuation
nor Project membership. The [native enrollment record](../design/native-relay-enrollment.md)
traces cryptography, journals, revocation and the evidence boundaries. Combined
Rust tests and mounted frontend/server composition pass; fresh packaged iOS,
actual process recovery and two-person public delivery remain unqualified.

## Native relay link intake

The [host intake](../../src-desktop/src/native_relay_link_intake.rs) owns bounded
invitation custody, public pending handles, cancellation and expiry. The
[typed envelope](../../packages/contracts/src/native-relay-link.ts) separates a
public first-contact route intent from an invitation bound to an already
approved native installation. The application address is an untrusted routing
hint. Opening a link grants no trust, Device, account, Project or execution
authority and does not select a Station.

iOS uses a distinct relay scheme and a
[Station-owned delivery boundary](../../src-desktop/src/native_relay_ios_launch.rs)
instead of the generic deep-link runtime, which retains its last raw URL. The
owned boundary captures cold launch options and consumes relay URLs before
the upstream warm URL parser. Pairing remains a separate journey. Android
does not register these relay schemes. Existing native candidate comparison,
explicit trust approval and grant redemption remain the authorization owners;
cancelled late grants use exact-grant retirement and durable cleanup.

The invitation review has its own React Query client so cold intake can precede
the main providers. [Native setup refresh hints](../../src-ui/src/platform/native/nativeRelaySetupState.ts)
notify the mounted [saved Station list](../../src-ui/src/views/connections-hub/RelayRouteProfiles.tsx)
when confirmation, redemption, Device activation or cleanup operations settle.
The hint names only the saved profile. Consumers refresh native profile metadata,
invalidate that profile’s trust, routing-grant and enrollment-recovery queries,
and validate fresh host responses; the hint
contains no credential, approval result or application authority. Closing the
review does not remount the protected root, and late replies still trigger
the host-state refresh.

Host and codec tests qualify their recorded source boundaries. The iOS-specific
callback ABI, installed cold/warm delivery, secret-log inspection and physical
collaborator journey require separate evidence. See the
[enrollment design](../design/native-relay-enrollment.md#native-link-intake)
for those limits.

## Native relay account and requests

The [selected connection owner](../../src-ui/src/platform/native/nativeRelayConnectionOwner.ts)
composes an opaque host Device binding with the
[application runtime](../../src-ui/src/platform/native/nativeRelayApplicationRuntime.ts).
Each request obtains fresh short-lived ICE and a verified Station peer; there
is no direct HTTP fallback. Exact supported health, authority and member Project
reads are admitted before allocation. Operator Workspace resources and writes
remain unsupported. The CLI does not select these routes as defaults.

The [account bridge](../../src-ui/src/platform/native/nativeAccountSessionBridge.ts)
uses the SDK native continuation client and fixed host proof operations. The
person session is independent of Device custody. The public account scope
qualifies query caches and requests by the current selected owner and session;
account rejection retires that scope without erasing the approved Device.
Changing the saved route, trust or binding fences prior results. The
[ApiBaseProvider](../../src-ui/src/contexts/ApiBaseContext.tsx) mounts this owner
into ordinary SDK requests and health probes. Its executed composition tests
mock native IPC and peers; they do not prove an installed client, arbitrary
provider support or a physical iPhone journey.

## NativeRelayGrantRenewalSupervisor

**Purpose and Interface.** The [supervisor](../../src-ui/src/platform/native/nativeRelayGrantRenewalSupervisor.ts)
maintains already redeemed native broker routing grants across the saved route
set. `start()`, `stop()`, `refresh()` and `getIssue()` expose lifecycle, fresh
observation and the route-limit outcome. The storage and renewal adapters are
constructor inputs; the currently selected Station does not choose which grants
are maintained.

**Composition and lifetime.** [ApiBaseProvider](../../src-ui/src/contexts/ApiBaseContext.tsx)
constructs it for desktop and mobile Tauri, starts it from the owning effect and stops
it on cleanup. It listens for saved-profile changes, online, focus, pageshow and
visibility changes. The work pump runs while the renderer is visible; waking
requests fresh host status. Visibility is rechecked after asynchronous status
lookup before a renewal starts. A host RPC already issued may finish after
hiding; this is foreground scheduling, not background continuity.
`stop()` removes listeners and timers and invalidates
route entries. More than 64 saved routes pauses all maintenance and reports a
route-limit issue, rather than silently maintaining a subset. The saved-route
view explains that limit.

**Renewal authority.** The [typed adapter](../../src-ui/src/platform/native/nativeRelayGrantRenewalAdapter.ts)
admits one existing grant with no pending cleanup and validates its exact saved
profile and host revision. The supervisor schedules renewal in the last 12 hours of the
24-hour renewal window and re-reads host status immediately before renewing.
Retries are bounded; removed/replaced profile generations cannot publish a stale
renderer result. This does not cancel a host request already in progress. The
[Rust renewal owner](../../src-desktop/src/native_relay_redemption.rs) serializes
renewal with retirement, records an exact retry intent in keyring custody before
network I/O, and checks profile/trust/grant identity again before accepting the
receipt. The renderer receives no routing credential or signing key.

**Evidence boundary.** [Supervisor tests](../../src-ui/src/platform/native/__tests__/nativeRelayGrantRenewalSupervisor.test.ts)
and [adapter tests](../../src-ui/src/platform/native/__tests__/nativeRelayGrantRenewalAdapter.test.ts)
exercise lifecycle, stale observations and bounded renewal decisions. They do not
prove background/suspended delivery, OS keyring parity or a deployed broker. This
module never approves Station trust, redeems an invitation, selects a native
application route, pairs a Device or grants Project access. See the
[broker lifecycle](../guides/self-hosted-broker.md#native-routing-grant-foundation-v2).


## PendingPairingCompletion

[The completion owner](../../packages/connect/src/core/pendingPairingCompletion.ts)
shares one pending pairing exchange across screens, then hands the accepted credential
to the first caller's durable completion policy.

**Intent and Interface.** `completePendingPairing(pending, { completePaired, signal?,
onProgress? })` returns one total `PendingPairingCompletion`: paired, post-exchange
failure, declined, expired, unavailable, identity changed, failed, or aborted.
`completePaired` is caller-owned durable local completion and also returns a total
result.

**Contract.** A flight is exact to endpoint, request kind, offer, proof, request,
expected environment, browser session, client instance and required account binding. Its
first subscriber owns completion policy; later subscribers join rather than compete. The
public entrypoint first uses a cached dynamic loader, so initial application startup
does not pay for polling/retry code. One in-flight import is shared; a rejected import
clears only the loader cache, leaves the persisted bearer request untouched, and makes a
later call retry before any exchange starts. After load, retry delays are bounded,
respect rate limiting, and wake only after their floor. A subscriber may abort without
cancelling a flight another subscriber needs. Terminal remote results clear the stored
pending exchange best-effort and local cleanup cannot reject a classified completion. A
successful exchange spends the remote proof; later local persistence failure is
`post-exchange-failed`, not permission to exchange again. Subscriber abort does not
reverse that completed exchange.

**Seam, Implementation, callers, and tests.** The package entrypoint publishes the
cached `completePendingPairing` loader. Its implementation is
`createPendingPairingCompletion`; that constructor is an Implementation-private test
seam for exchange, clock, waiting, and local-clear Adapters. Production callers are the
Connect pairing flows. Real loader and Interface coverage is
`packages/connect/src/__tests__/pendingPairingCompletion.test.ts`. **Do not
reintroduce:** eager pairing import at shell startup, per-screen polling, competing
`completePaired` policies, or caller-owned retry timing.

## SessionQueryModule

This is the read boundary for a Session’s messages and exact answer/input/result references. It keeps authorization and event interpretation together so routes and Knowledge readers do not each reconstruct a different answer. The [query implementation](../../src-server/services/orchestration/session-query-module.ts) separates transcript replay from bounded Basis descriptors.

**Interface.** `read({ type: 'conversation', threadId }, authority)` returns a conversation with ordered messages, `not-found`, or `unavailable`. The same module exposes exact `readAssistantTurn`, `readUserInput`, `readToolResult`, and `readAnswerBasis` operations. It has no mutation operation.

**Behavior.** The Implementation resolves the session, checks authority, then replays its events exactly once in stored order. An absent session and denied authority are both `not-found`, preventing disclosure. Title and messages are derived from that same event set. Exact assistant-answer reads require a normally completed, non-cancelled turn and return its latest eligible answer. Input and result reads use event identity, not transcript position. Basis reads use an exact descriptor-only turn window (at most 1,000 events and 128 KiB at the storage owner); raw replay fallback is rejected, and corruption has a separate outcome. Durable query failure becomes `unavailable`, not an empty successful read.

**Code and evidence.** `OrchestrationService` composes the Module from private session lookup, authorization, and event-reader Adapters. The migrated callers are the orchestration conversation route and `knowledge-store/adapters/conversation-store.ts`; runtime composition passes that same Interface to hosted callers. Quote-source, answer, tool-result, and Basis callers use the corresponding exact-read operation. Other inventories remain with their owning modules. The message-list route maps `not-found` to an empty list; exact-answer routes use non-disclosing refusals. The focused real contract is `src-server/services/orchestration/__tests__/session-query-module.test.ts`. **Do not reintroduce:** route-local authorization plus event replay, or expose the event store as a query Interface.

## StationControlDispatchScope

An agent tool can cause the server to resolve an Agent, use a Connection or
contact another Station. The scope decision must happen before those later
server operations. [StationControlDispatchScope](../../src-server/runtime/mcp/station-control-dispatch-scope.ts)
reads the target facts used by the shared
[caller policy](../../src-server/tools/station-control-policy.ts).

**Interface and ownership.** `target(ref, action)` resolves a new Session,
thread or Conversation from Station-owned records. The caller supplies a
reference, not trusted owner/Project facts. The result identifies the recorded
owner, effective Project/global scope, remote placement, required Project
action and whether the Conversation lineage includes host execution. A
Conversation target uses its newest started Session. Directory scope uses the
deepest containing canonical Project directory; missing or unreadable paths
cannot establish a target. This does not rewrite a Session's stored Project.

**Admission.** A bound operator retains operator reach under ordinary route
authorization. Other callers must target the same recorded owner, stay local
and satisfy the required Project action. A caller without bound assurance must
also stay within its own Session's Project/global scope and avoid host
execution. Approving a global target requires the operator. These are verified
Station-control caller rules, not additional restrictions on every paired
person UI request.

**Composition and evidence.** [Runtime routes](../../src-server/runtime/routes/runtime-routes.ts)
supply record readers and Project authorization. The
[dispatch route helper](../../src-server/routes/orchestration/dispatch-scope.ts)
applies the shared rule before privileged downstream hops and passes the
resolved directory rather than the caller's original alias. The
[execution-target resolver](../../src-server/services/execution-target/execution-target-resolver.ts)
also requires local Project cwd overrides to exist inside that Project when
there is no separately verified remote path. Source tests include the
[scope reader](../../src-server/runtime/mcp/__tests__/station-control-dispatch-scope.test.ts),
[mounted route composition](../../src-server/runtime/routes/__tests__/runtime-routes-station-control-dispatch-scope.test.ts)
and [target resolver](../../src-server/services/execution-target/__tests__/execution-target-resolver.test.ts).

**Not only dispatch.** `rename_session`'s
[route](../../src-server/routes/chat/agent-conversation-title.ts) holds a
caller to the same rule for a stored conversation, which has no Session record
to read: it asks `target` for the Project named in the conversation's own
metadata (global when it names none) and passes that to the shared rule, after
the owner check (which a bound operator caller skips). A named Project Station cannot read refuses.

**Start-time repeat.** The resolved directory is still a string when the engine
starts. For a new Session and any caller except a bound operator, the route
helper also returns its decision as a
[DispatchCwdAdmission](../../src-server/services/orchestration/dispatch-cwd-admission.ts).
The dispatch carries it in the start's command context, never in a request
body or to another Station. `OrchestrationService` runs it when it prepares
the start and again directly before the adapter call, outside the start
boundary so a refusal is recorded as a rejected start rather than an uncertain
one. It decides on the directory the start is bound to: the Session's own
`cwd`, or, when the Session has none, the directory its ACP connection
configures (`resolveConnectionDefaultCwd`, wired by
[runtime initialization](../../src-server/runtime/bootstrap/runtime-initialize.ts)
from the config the adapter reads). A directory Station provisioned itself,
such as a worktree, is not substituted. The admitted canonical path is written
to the Session's start metadata as `dispatchCanonicalCwd`; a caller-supplied
value is removed first. Recovery and the credential-profile restart compare
the re-resolved folder with that record before starting an engine, and a
continuation child in the same folder inherits it. The refusal reaches the
dispatch route as an error with a station-control code and becomes a 403.
The repeat does not hold a directory handle: the adapter resolves the path
once more when it spawns the process. Conversation forks and non-engine uses
of the folder are outside it. So is a later start for a Session that carries
no record, one the operator started or one started before the record existed:
a constrained caller's follow-up to it gets the route's admission check only,
not the check before the engine starts. The
[spawn composition test](../../src-server/runtime/routes/__tests__/runtime-routes-station-control-dispatch-spawn.test.ts)
drives both dispatch routes into a real `OrchestrationService` with a recording
engine double, and the
[runtime wiring test](../../src-server/runtime/bootstrap/__tests__/runtime-initialize-connection-default-cwd.test.ts)
covers the connection reader; the credential-profile restart has no test.
Their presence is not a new executed or remote-device receipt. See
[agent configuration](../guides/self-configuring-agent.md#dispatch-authority) for tool-level
restrictions and caller binding.

## SessionMessageDelivery

An agent that messages another Session must not deliver twice when it retries,
and must not start a second turn on a Session that is already running one.
[SessionMessageDelivery](../../src-server/services/orchestration/session-message-delivery.ts)
is the one place that decides which of those a message becomes, for Station
Control's `send_to_session` and later for delegation result delivery.

**Interface.** `deliverSessionMessage(ports, { threadId, text, mode, deliveryId,
decided?, recordDecision? })` returns `started`, `steered`, `session_busy`,
`no_active_turn`, or `indeterminate`. `decideSessionDelivery(mode, busy)` is the
pure rule: `auto` steers a running Session and starts an idle one, `start`
refuses a running one, and `steer` refuses an idle one. The module performs
nothing itself: the caller supplies the ports for the busy check, a turn start,
and a receipted steer, each already authorized.

**Idempotence.** `deliveryId` is the `clientTurnId` of a start and the
`clientInputId` of a steer, so the durable turn claim and the steer receipt
deduplicate a re-driven delivery. `decided` pins the branch a first attempt took
(recorded through `recordDecision` before its effect), so a re-drive never turns a
steer into a start because the turn ended in between. An engine without mid-turn
input answers the steer as `session_busy`, never as a start.

**Composition and evidence.** The
[route](../../src-server/routes/orchestration/session-agent-control.ts) checks
the caller's scope and keys each request in the durable
[request-key table](../../src-server/services/orchestration/session-control-request-keys.ts)
(owned by `EventStore`) before it reaches this module. `wait_session` observes
the same lifecycle fold the steer path reads through
[SessionTurnWaiter](../../src-server/services/orchestration/session-turn-wait.ts),
which never acts on the Session. Source tests are the
[delivery decision table](../../src-server/services/orchestration/__tests__/session-message-delivery.test.ts),
the [key table on SQLite](../../src-server/services/orchestration/__tests__/session-control-request-keys.test.ts)
and the [mounted boundary matrix](../../src-server/runtime/routes/__tests__/runtime-routes-station-control-session-control.test.ts).
Their presence is not an executed receipt against a real engine. See
[agent configuration](../guides/self-configuring-agent.md#session-control) for the
tool-level behavior.

## SessionDigest

An agent deciding whether a peer Session is worth a full transcript read needs
a cheap account of it, and that account must be what Station recorded, not a
model's summary. [SessionDigest](../../src-server/services/orchestration/session-digest.ts)
folds the recorded facts of a conversation's turns into that account for Station
Control's `get_session_digest`, and the
[route](../../src-server/routes/orchestration/session-project-activity.ts) that
serves it also serves `list_project_activity`.

**Interface.** `EventStore.readTurnDigestFacts(threadIds, { beforeGlobalSequence,
turnLimit })` selects and aggregates in SQLite the facts of a window of turns,
newest first: the turn's `turn.started` (a steer is not a turn) with a bounded
prompt prefix, its last terminal event, a count of `tool.started` by tool name,
the path argument of a successful call whose own `tool.completed` reported an
`edit`, `delete` or `move` kind, and the `pull-request` rows the turn declared.
`digestTurn(facts, children)` bounds each field and `fitDigestPage(turns)` takes
the longest prefix under 8 KiB, throwing rather than serving a turn that alone
exceeds it. `encodeDigestCursor` and `decodeDigestCursor` carry the paging
position, the oldest returned turn's `turn.started` global sequence.

**Invariants.** Nothing is summarized and nothing is named that nothing
computes: a fact that was not recorded is absent (no files for an engine that
reports no tool kind), and a turn with no terminal event is `open`, not
guessed. Each field is bounded and says when it was collapsed, so a page ends
for the byte cap, never by cutting a turn, and paging covers each turn once.
Delegated children are the Sessions Station derived as launched from the
conversation (`listSessionsNamingParents`, `stationDerived`), placed in the turn
during which they started, and a child the caller may not see is not counted.

**Composition and evidence.** The route decides authority per Session before
reading anything: the owner-scoped read model, the shared scope rule
(`stationControlScopeRefusal` with the owner's Project `view` action), and no
remote host. A Session out of scope reads as not found. The status word is
`sessionLadderWord` in the
[session-attention contract](../../packages/contracts/src/session-attention.ts),
the derivation the UI's status ladder also reads. The
[mounted matrix](../../src-server/runtime/routes/__tests__/runtime-routes-station-control-project-activity.test.ts)
drives every caller kind against same-Project, other-Project, global, other-owner
and remote targets over real events, and the
[fold tests](../../src-server/services/orchestration/__tests__/session-digest.test.ts)
pin the bounds. Their presence is not an executed receipt against a real engine.
See [agent configuration](../guides/self-configuring-agent.md#project-activity)
for the tool-level behavior.

## ConversationSessionLineage

A conversation is the continuing human thread; an execution Session is the engine instance serving part of it. [Lineage](../../src-server/services/orchestration/conversation-session-lineage.ts) records their immutable order. [Continuation policy](../../src-server/services/orchestration/conversation-lineage.ts) decides whether to reuse the current Session or reserve a successor.

**Interface.** `establishInitialSession` records the legacy root,
`sessionsForConversation` returns immutable ordinal lineage, and
`reserveNextSession` atomically chooses one child when the current session
cannot take the next turn.
`backfillLegacySessions` is startup-only composition work. No caller receives a
table operation, SQL handle, or an ability to select a current session.

**Behavior.** This additive slice preserves
`orchestration_conversation_history.thread_id` as the legacy conversation id.
For every persisted provider session it writes at most one ordinal-zero mapping
whose conversation and session ids are equal. The unique session identity and
per-conversation ordinal make repeat startup and concurrent Store instances
idempotent only when every immutable lineage fact matches. A session claimed by
another conversation, an occupied ordinal, or a changed immutable fact fails
with a typed conflict instead of being accepted as an existing mapping. It
copies only an existing provider-session identity and creation
time; a history row without a provider session remains intentionally unmapped.
The unique predecessor index means concurrent continuation attempts receive the
same reserved child instead of creating sibling execution sessions.

A conversation keeps one live execution session (#2540). A turn's outcome
never ends its session. A finished turn rests it `idle` (at rest and reusable,
not the terminal `completed`), and a failed or stopped turn rests it `failed`
or `canceled`. Either way the next turn runs in that session, with its engine
still resident, or restarted in place from its resume cursor. A child is
reserved only when the current session cannot take the turn:
- it was explicitly closed (terminal `completed`);
- its engine binding is `closed`, `dead`, or `error`;
- the engine cannot apply a requested model switch per turn;
- an explicit handoff or a context boundary asks for one.

`OrchestrationService` parks an at-rest engine left unused past
`idleSessionParkAfterMs`, provided it is at rest, has no active turn or reported running child work,
has a saved resume cursor, and is not known to lack resume support.
Parking stops the process but absorbs its exit, so the session stays dormant
rather than ending: the next turn restarts it in place. No worktree, claim or
room effect fires.
`isSessionLifecycleStateAtRest` answers "is this session doing anything";
`sessionLifecycleOutcome` is the one lifecycle-to-outcome mapping.

A model change on a Session that never ran a turn also names it for retirement.
The stop is `OrchestrationService.retireNeverRanSession`, decided under that
Session's lifecycle lock: it refuses a Session with turn facts, a dispatched or
active turn, or one that is the conversation's current Session again. A send that
has resolved the predecessor but not yet called `dispatch` is not visible to it.

A child reservation is not an engine start and carries no caller-controlled workspace,
owner, tenant, cursor, or transcript fact. Those remain composed by the
foreground/orchestration seam from the immutable predecessor binding.
Conversation closure and multi-session event/history aggregation remain outside
this Module. Readers aggregate through the lineage order it records: the
conversation event window and the conversation message read
(`conversationSessionIds`) both cover every Session, oldest first.

**Code and evidence.** `EventStore` composes the
private SQLite persistence Adapter at startup and while it first persists a
provider session. `OrchestrationService` uses its intent-shaped EventStore seam
to reserve one child only after it has observed that the predecessor cannot
take the next turn; foreground execution starts that child with copied binding/cursor or
a bounded transcript fallback. Real SQLite fresh-store, legacy-backfill,
rerun, uniqueness, concurrent reservation, and preservation proof lives in
`conversation-session-lineage.test.ts`; lifecycle-backed service proof lives
in `orchestration-service.test.ts`. **Do not reintroduce:** raw lineage-table
access from routes/services, event/cursor rewrites, inferred workspace
ownership, or an implicit change to completed-session behavior.

## SessionCommandModule

Starting a Session crosses two boundaries: an engine may start, and Station must record the command’s result. The [command owner](../../src-server/services/orchestration/session-command-module.ts) reports those facts separately; losing a receipt must not invite a second engine start.

**Interface.** `execute({ type: 'start-session', input }, context)` is the closed caller Interface. It always returns one of `accepted`, `rejected`, `failed`, or `indeterminate`, together with a receipt and `receiptStatus: persisted|unavailable`. `accepted` has a persisted accepted receipt and a session. `rejected` and `failed` report whether their terminal receipt is durable. `indeterminate` covers uncertain provider creation as well as missing accepted-receipt durability; a Session is included only when one is known. The server-only `executeInternal` also carries recovery, Task dispatch, owned-workspace, and portable-execution admission capabilities. Those options are not accepted from public command JSON.

**Behavior.** The Module initializes and records dispatch before launch, then starts, attaches, and binds before persisting `accepted`. A fault before the provider call can return `failed`; a terminal receipt persistence fault returns `failed` or `rejected` with `receiptStatus: unavailable`. After a session effect, an accepted write/readback fault returns `indeterminate`, never overwrites the accepted attempt with `failed`, and must not be retried automatically. A durable readback matching command ID, thread, command type, and accepted status turns a write-success-then-throw into `accepted`. Ordering and receipt-fault classification stay inside the module. `failed` is not a universal proof that no engine started: ordinary errors in later attachment or binding work also use that outcome. Inspect the known Session and receipt rather than inferring retry safety from that word alone.

**Code and evidence.** `OrchestrationService` composes receipt, session-state, launch-policy, and binding Adapters; orchestration routes and Station Control tools use the public Module. Receipt initialization, dispatch recording, accepted persistence, terminal persistence, and exact readback are total at this Interface: warning observation is best effort and cannot make `execute` reject. Evidence lives in `src-server/services/orchestration/__tests__/session-command-module.test.ts`, `orchestration-service.test.ts`, orchestration route tests, and Station Control tool tests. **Do not reintroduce:** exported callback bags, route-specific start sequencing, an untyped command string, a receipt fault that rejects `execute`, or an automatic retry of `indeterminate`.

### Harness question interaction

`packages/contracts/src/harness-questions.ts` owns the types; the shared
subpath owns descriptor parsing and complete-batch validation. Provider
normalization maps Claude AskUserQuestion and Codex requestUserInput into the
canonical request event. SessionCommandModule validates the current event
and answer batch before the adapter translates it back to the harness.
Optional Codex requests carry `blocking: false` through resolution and
snapshot projection so they do not pause or revive turn progress.

The lazy inline HarnessQuestionRequest captures the scoped SDK transport and
exact event identity. HarnessQuestionCard owns selection, keyboard use, review
and submission. Its IndexedDB draft owner keys non-private answers by the
verified durable authority namespace and exact request; transport epoch
changes fence the rendered card without discarding that authority's draft.
Private answers are excluded from drafts and masked in review. This boundary
does not redact engine history or establish engine acknowledgement.


## SessionLifecycleModule

Marking a Session complete can race a new turn. The [lifecycle module](../../src-server/services/orchestration/session-lifecycle-module.ts) coordinates the transition with provider invocation and reruns its checks after completion preparation, so an old view cannot close newly active work.

**Interface.** `transition({ threadId, authority, to, ... })` is the single public lifecycle-mutation Interface. It authorizes and reads the session, validates the legal transition, runs completion gates, revalidates after the awaited completion preparation, publishes one canonical transition, and returns the resulting session projection. A missing or denied session is indistinguishable at this boundary.

**Behavior.** Distinct provider turn startups serialize at the invocation boundary; a caller joining the same client-turn idempotency claim does so before that boundary. Lifecycle mutation takes exclusive ownership with writer preference and the same durable cross-process thread fence. A provider acceptance becomes an active local and durable fact before its asynchronous `turn.started` event can arrive. Completion refuses provisional, accepted, and indeterminate provider effects. If lifecycle wins first, a queued turn start re-reads the completed state and never invokes the provider. Completion gates cannot publish from a stale pre-await lifecycle projection: state and active-turn evidence are checked again before workflow delivery and the terminal event. Observer failures cannot overturn a published transition. Publication precedes the final Session read; a failure of that read can reject the request after publication, so a missing response is not proof the transition did not occur.

**Code and evidence.** `OrchestrationService` composes session reads, Flow/policy completion, workflow publication, canonical event publication, and observation Adapters into `SessionLifecycleModule`; the lifecycle route calls that Module directly. `SessionExecutionCoordinator` composes the durable boundary below and owns process-local waiter fairness; neither is a caller mutation Interface. Direct contract and synchronized integration evidence lives in `session-lifecycle-module.test.ts`, `session-execution-coordinator.test.ts`, `session-turn-boundary.test.ts`, `orchestration-service.test.ts`, and orchestration route tests. **Do not reintroduce:** a lifecycle method on the broad service, a check-before-await without post-gate revalidation, an untracked gap between provider acceptance and `turn.started`, a process-only provider boundary, or a mutex around idempotency-claim joining.

## SessionTurnBoundaryAuthority

This owner records when a provider call may have crossed into an external effect. It is the durable counterpart to process-local coordination: a restart must not turn an unknown outcome into permission to replay. The [claim protocol](../../src-server/services/orchestration/session-turn-boundary.ts) and EventStore’s SQLite adapter share that responsibility.

**Interface.** `claim(threadId, now)` returns an opaque, one-way capability that may move only `prepared → invoking → accepted|indeterminate`, or remove a definitely uninvoked/terminally observed boundary. `claimLifecycle` acquires the conflicting per-thread lifecycle capability. Lifecycle code receives only `hasPossibleEffect`; canonical terminal projection receives only `observe`. A caller cannot supply an owner token or arbitrary stored state. The same authority separately owns Session-start and Task-dispatch claims; those have no invented provider turn ID. `recordProviderTurn` records an engine-initiated turn directly as accepted, without pretending a user command started it.

**Behavior.** The SQLite authority serializes cross-process claims with a transaction. Independent accepted turns may coexist up to a bounded protected per-thread capacity; the Module rejects further work at capacity and never prunes unresolved facts. A provider response that reuses any turn id already present in canonical terminal history becomes `indeterminate`, so a delayed or duplicate old callback cannot settle the newer effect. A lifecycle claim conflicts with every retained provider boundary, while a new provider invocation conflicts with lifecycle, another invocation, or indeterminate work. An Adapter error after `beginInvocation` is possible effect and never releases client idempotency for replay. Ambiguous boundary writes retain their exact opaque intent and retry it before later work without reinvoking the Adapter. A dead `prepared` owner is definitely uninvoked and removed; a dead `invoking` owner becomes durable `indeterminate`, including when an already-open peer discovers the dead owner during contention. Exact provider terminal identity removes matching accepted evidence; a session-wide terminal can clear older identity-less turn/start ambiguity. Task-dispatch records are excluded from provider terminal cleanup because provider exit alone does not settle graph and publication work. An interrupt acknowledgement is not terminal evidence: acceptance and the client-turn claim remain until an exact canonical terminal arrives. Post-accept observers cannot replace the known turn result; if command-receipt persistence is not known durable, service, HTTP, and SDK retain the accepted turn and add `receiptStatus: unavailable`.

**Code and evidence.** `EventStore` owns SQLite and process identity, then exposes one private `SessionTurnBoundaryAuthority` to `OrchestrationService`. The in-memory Adapter exists only for embedded/test composition and preserves the same capability shape without claiming restart durability. Real two-EventStore, restart, exact-terminal, adapter-throw, route no-retry, and lifecycle race evidence lives in `session-turn-boundary.test.ts`, `orchestration-service.test.ts`, and orchestration route tests. **Do not reintroduce:** generic ledger access, caller-owned state strings, release-after-invocation, session-id inference for turn settlement, a thread-global terminal tombstone shared by concurrent starts, or lifecycle checks that ignore the durable boundary.

## TurnDeduplicator

A repeated client message should join the same turn instead of invoking the engine again. The [deduplicator](../../src-server/services/orchestration/turn-deduplicator.ts) maps a retained `(threadId, clientTurnId)` to its provider turn; the separate invocation boundary records whether a provider effect remains possible.

**Interface.** `claim({ threadId, clientTurnId })` returns either an opaque owner `TurnClaim` or `contended`; `awaitResolution` observes durable resolution. Only the owner capability can `resolve(turnId)` or `release()`.

**Behavior.** The SQLite store admits one current owner across concurrent connections and restart. A contending caller may receive an already-resolved turn ID or wait for one. An unresolved claim can be reclaimed only when its recorded process owner is provably dead or its exact birth identity changed; unknown liveness remains contended. A claim latches its exact transition: after a durable write fault the same transition may retry, while a changed transition or double success is rejected. Resolved rows are oldest-first pruning candidates at the shared default soft 2,000-row ceiling; unresolved rows are never capacity victims. Deduplication lasts while the row is retained. Reclaiming a dead owner is not permission to repeat a possible provider effect: the invocation-boundary owner must still admit the call.

**Code and evidence.** `EventStore` composes its private `src-server/services/orchestration/sqlite-turn-dedup-persistence.ts` coordinator into the Module; orchestration callers receive only the Interface. `src-server/services/orchestration/__tests__/turn-deduplicator.test.ts` uses real temporary SQLite for ownership, restart, and fault behaviour. The separate `/chat` facade retains its own `EventStore` chat-turn family because it owns conversation-id replay, bounded retention, and direct-route compatibility; it is not a second TurnDeduplicator caller family. **Do not reintroduce:** a process-local map, raw `(threadId, clientTurnId)` updates, elapsed-time takeover or pruning unresolved claims, or a generic ledger wrapper around the retained chat-turn facade.

## AdoptionLedger

Adopting a discovered read-only engine session may fork a provider child before Station can save it. The [adoption ledger](../../src-server/services/orchestration/adoption-ledger.ts) retains that intermediate ownership so restart recovery can finish or compensate the exact attempt.

**Interface.** `reserve`, `reclaim`, `reservations`, and `reservesProviderCursor` own one attached-session continuation. Owner results carry immutable `OwnedAdoption` with legal methods for forking, provider cursor, Flow binding, rollback, cleanup, and atomic `commit`.

**Behavior.** Pending reservations may record legacy Flow compensation facts, then advance once to forking. New adoption does not attach a Flow run; these fields remain for reservations left by the retired path. Provider cursor is write-once except an identical retry. Commit needs forking, a provider cursor, and matching child/provider/cursor facts; it atomically persists the child and any supplied command receipt while removing the reservation. Rollback is terminal; only there may both cleanup facts be recorded before removal. Ownership loss and invalid transitions are typed outcomes. A durable Adapter failure keeps the exact capability retryable; snapshots cannot forge or alter its owner token.

**Code and evidence.** `EventStore` composes the private `src-server/services/orchestration/sqlite-adoption-persistence.ts` coordinator, injecting the child-session and command-receipt writes its atomic commit performs. `AttachedSessionFollowService` and orchestration adoption paths consume the Interface. Real SQLite contention, restart, fault, legal-transition, and atomicity proofs are in `src-server/services/orchestration/__tests__/adoption-ledger.test.ts` and attached-session/orchestration suites. **Do not reintroduce:** EventStore forwarding methods, unrestricted merge/update operations, caller-supplied ownership tokens, or split commit writes.

## RecoveryLedger and private CredentialApplicationFactory/Handle

Recovery must distinguish a requested retry, an observed provider turn, and an adopted credential profile. The [recovery ledger](../../src-server/services/orchestration/recovery-ledger.ts) owns dispatch state; the [credential application protocol](../../src-server/services/orchestration/credential-application-ledger.ts) owns the separate profile mutation and its acknowledgement.

**Interface.** `RecoveryLedger` owns recovery arm, immutable projection, due/profile claim (plus the user's immediate claim of a waiting usage-limit stop), observed provider correlation, terminal/cancel, compensation, and startup reconciliation. A `RecoveryClaim` closes over one dispatch attempt and can replay with correlation, release only before invocation, accept provider evidence, become indeterminate, and prepare a credential application. `prepareCredential` passes the claim-local opaque application key to private `CredentialProfileRecoveryAdapter.stage`; its `ConnectionService` Implementation calls `CredentialApplicationFactory.start` and returns a state-bound `CredentialApplicationHandle` for reserve/stage/settle/ack. This is deliberate dual composition: RecoveryLedger owns dispatch truth while Factory/Handle owns exact credential evidence. The correlation key crosses only the server-owned recovery/connection composition; it is removed from snapshots, route projections, and configuration output.

**Behavior.** A prepared claim is releasable only before external invocation. After invocation, only durable provider acceptance can produce success; observed or unknown provider work is indeterminate and is never silently retried. Startup reconciliation fences abandoned prepared work and returns the records it successfully observed or changed. Its current scan wrappers return an empty list on a coordinator exception as well; an empty sweep is therefore not proof that storage has no remaining obligations. Credential application is linked before profile mutation, has exact settlement and acknowledgement, and keeps unacknowledged evidence through restart. The private store retains at most 64 unacknowledged applications, while preserving terminal capacity for an already staged attempt. Claims, startup handles, immutable snapshots, and exact compare-and-set results prevent foreign settlement. Linked obligations receive scoped work; they never fall through to broad cleanup. An unlinked legacy prepared row is conservatively quarantined; it never authorizes a broad rollback. A still-waiting intent (armed, never claimed) can be retired without a dispatch as `manual` or `canceled`, with an `outcomeReason` the projection carries (#3157). Shutdown fences every pending intent except a usage-limit one that only waits for its reset or was left to the user because automatic resume was off; those hold no dispatch, and a restart rebuilds the waiting timer. Only usage-limit intents are gated: when one is due, `SessionRecoveryCoordinator` reads the `usageLimitAutoResume` setting and retires the intent if a newer turn started in the conversation, a request is open, or the Session closed; a newer turn also retires one left to the user. Ordinary timed recovery is unchanged.

**Code and evidence.** `EventStore` composes the private RecoveryLedger and CredentialApplicationFactory/Handle Implementations over SQLite at runtime startup. `SessionRecoveryCoordinator` uses ordinary recovery claims; `CredentialRecoveryModule` receives opaque startup/claim capabilities and the concrete credential Adapter. Real SQLite proof is in `recovery-ledger.test.ts`, `credential-application-ledger.test.ts`, `credential-recovery-module.test.ts`, and `session-recovery-coordinator.test.ts` under `src-server/services/orchestration/__tests__/`. **Do not reintroduce:** `RecoveryDispatchSettlement`, process-local correlation maps, raw attempt IDs, public storage reopen operations, or automatic retry of indeterminate work.

## CredentialRecoveryModule

An automatic profile change is a compensation protocol, not a switch followed by a blind retry. The [recovery module](../../src-server/services/orchestration/credential-recovery-module.ts) stages a candidate, dispatches through the existing session owner, and commits or rolls back from exact provider and registry outcomes.

**Interface.** `recover`, `complete`, `abandon`, and `reconcile` form one compensation protocol for credential-profile recovery. Each returns a total recovery or reconciliation outcome rather than making callers infer stage/commit/rollback order.

**Behavior.** A recovery call waits for the shared startup reconciliation attempt before staging. The caller currently does not require that attempt’s result to be `reconciled`; an `indeterminate` result leaves the startup pass eligible for another attempt rather than acting as a global staging barrier. `unavailable` stage truth alone permits ordinary recovery fallback; a staged or indeterminate attempt remains exact compensation work. Candidate session restore or quarantine happens independently of registry cleanup. Commit, rollback, inspect, and acknowledgement are exact, typed facts; cleanup failure keeps durable authority for later scoped retry. A live completion acts only through its original claim; bulk prepared reconciliation is startup-only.

**Code and evidence.** `OrchestrationService` composes RecoveryLedger, `RecoveryDispatchAdapter`, credential profile Adapter, session restore/quarantine functions, and clock. `SessionRecoveryCoordinator` routes profile recovery to it. Real lifecycle, compensation, two-instance, and provider-truth coverage is in `src-server/services/orchestration/__tests__/credential-recovery-module.test.ts` and `session-recovery-coordinator.test.ts`. **Do not reintroduce:** credential callbacks on the coordinator, profile policy in a provider Adapter, broad rollback for linked work, or ad-hoc restart maps.

## ConnectionInspector

[ConnectionInspector](../../src-server/services/connections/connection-inspector.ts)
turns adapter observations into an inventory with explicit freshness and gaps.
[ConnectionService](../../src-server/services/connections/connection-service.ts) owns
when that observation may be published.

**Intent and Interface.** `inspect(request)` returns a total inventory: `inspected` with
freshness/provenance/partial facts, or `timed-out`, `aborted`, or `unavailable` with an
honest empty partial inventory.

**Contract.** Each call performs a fresh Adapter observation with bounded concurrency
and result projection. Cancellation and a deadline come from the optional caller signal;
the inspector does not start its own timeout. It distinguishes a `TimeoutError` abort
from other aborts. Built-in adapters declaring awaited abort settlement get a separate
bounded cleanup wait; arbitrary asynchronous work is not forcibly stopped. The
launchable-model refresh supplies a signal, while ordinary runtime inventory calls can
omit one. Command/prerequisite inclusion and discovery policy are explicit inputs.
Public connection identity is mapped at the composition Seam from the Adapter's
canonical EngineId. Partial results state whether facts came from live observation,
built-in fallback, or neither. Adapter failure cannot throw through the total Interface
or make diagnostics break inspection.

**Seam, Implementation, callers, and tests.** `ConnectionService` composes provider
Adapters, app/ACP configuration readers, public identity mapping, and clock, then keeps
`ConnectionInspector` private to its inventory publication path. A non-`inspected`
outcome rejects publication with an explicit retry-before-publish error; routes receive
the resulting projection rather than classify inspection facts themselves.
Engine attribution does not depend on that publication: the inspection is total, so one
failing Adapter or a timed-out read would erase every connection's engine.
`listEngineConnectionIdentities` derives each registered connection's `engineId` from the
Adapter (`engineIdForAdapter`, `'acp'` for ACP connections) through the same public-identity
resolver, per Adapter, with no probe; the Agent catalog and `/:slug/binding` read it, while
readiness keeps the live read (#3355).
`src-server/services/connections/__tests__/connection-inspector.test.ts` covers timeout,
abort, provenance, partiality, identity isolation, and bounded concurrency. **Do not
reintroduce:** route-local Adapter loops, runtime-id-as-public-id, a cache that claims
freshness it did not observe, or route-level mapping of inspection failure.

## SecretBindingAdministration and IntegrationSecretResolver

[Secret binding
administration](../../src-server/services/secrets/secret-binding-administration.ts)
stores references and grants. The [MCP establishment
adapter](../../src-server/services/secrets/mcp-secret-child-env.ts) materializes
selected secrets only for a new child connection; metadata reads do not fetch secret
bytes.

**Intent and Interface.** `SecretBindingAdministration` owns metadata-only create,
replace, grant, ungrant, revoke, list, and get operations.
`IntegrationSecretResolver.resolveForIntegration` is a separate, narrower capability
that resolves only the exact bindings selected for one MCP child establishment.

**Contract.** The private file Adapter accepts only a bounded v1 document at
`<STATION_HOME>/security/secret-bindings.json`, with a private real directory/file,
strict ids/grants/timestamps, and Datum-parsed `AuthRef` values. Binding ids are never
reused; revoke is terminal. Replacement, grant changes and revocation compare the
expected revision under the file mutation lock and increment that binding revision;
creation allocates a new identity. List/get derive non-secret backend availability with
Datum only; they never materialize. Resolution requires one current, non-revoked exact
integration/env grant, materializes each distinct binding at most once per call, returns
no cache, and maps Datum failures to Station-safe reason codes.

**Seam, Implementation, callers, and tests.** Runtime bootstrap constructs
`FileSecretBindingAdministration`, retains administration for `/api/secret-bindings`,
and injects the narrow resolver into MCP establishment. `establishMcpSecretChild()`
resolves fresh child-only environment values and records success only after
connection/handshake succeeds; unsupported transports and the built-in station-control
child refuse authored injection. Changing grants does not erase values already delivered
to a running child. The same store separately implements `resolveForAcpProvider()` for
exact connection/provider/header grants, consumed by the ACP provider-configuration
route; that is not generic MCP header injection. The Datum adapter is the contracts
subpath `datum-secret-reference`, keeping Datum's public reference grammar and runner
private from the contracts root and browser consumers. Focused storage/resolution proofs
are `src-server/services/secrets/__tests__/secret-binding-administration.test.ts`. **Do
not reintroduce:** inline secret bytes in the binding store, local AuthRef parsing or
backend switches, a resolver list/get capability, materialization during inspection,
unscoped grants, process-wide secret caches, delete/reactivate, or raw Datum error
messages beyond this module.

### Engine identity boundaries

`EngineId` is the single canonical engine-implementation identity used by Adapters,
connection types, and capability-matrix keys. `EngineConnectionId` remains a separate
branded identity for a configured, navigable connection instance, and `AgentId` remains
a distinct branded Agent namespace. `adapter-identity.ts` derives an Adapter's canonical
EngineId and optional public connection identity without a private runtime selector.
`ConnectionService.listEngineConnectionStates()` publishes canonical `engineId`,
navigable `engineConnectionId`, and enabled state directly. The enriched-Agent API, SDK
query, and UI share `EnrichedAgentProjection`, which likewise carries capability
`engineId` separately from `execution.agentConnectionId`. Built-in Adapters use the
contract factories, while the plugin loader validates untyped metadata at admission and
ACP connection identities are validated before persistence and again on load. **Do not
reintroduce:** a generated runtime suffix, a second Adapter engine selector,
provider-name reconciliation, or read-time identity aliases.

### Finish-reason clear authority

`providers/finish-reason-authority.ts` owns `PROVIDER_PROVEN_FINISH_REASONS`: the
allowlist of `turn.completed` finish reasons that positively prove a provider ran a
whole turn — the single decision point for every "does this completion clear a recorded
failure" question. Two consumers: runtime auth-health clearing
(`runtime-auth-health-monitor.ts`) and session-scoped `runtime.error` supersession in
both event-store projection folds (station#3485). Membership is typed against the
contracts `finishReason` union, and each consumer pins its own stake with tests, so
widening the set is a decision made once, visibly, for all of them. **Do not
reintroduce:** a per-consumer copy of the set, an exclusion-list ("everything except
`cancelled`/`other`") formulation (fail-open — station#3509), or clear authority granted
to `'other'`/absent reasons without a decision recorded here.

## ExtensionNotificationBindings

**Purpose.** Vendor extension notifications remain opaque until Station has an
exact handling rule for their `(namespace, type)` tuple. The immutable
[shared table](../../src-shared/extension-notification-bindings.ts) records that
rule, the adapter or protocol variant and an observation or pinned SDK contract tag.
`extensionNotificationBinding()` returns an exact match or absence. A matching
namespace prefix, version string or stored capability flag is not a match.

**Current callers.** The [ACP mapper](../../src-server/providers/adapters/acp-adapter-events.ts)
updates retained commands for `acp.commands.available` and retains bounded
same-turn error context for `acp.turn-error-cause`. It still publishes the
opaque event. The [UI handler](../../src-ui/src/hooks/orchestration/extensionHandlers.ts)
handles Kiro authentication/compaction, Claude activity and retained task
history, and engine MCP progress. `acp.host-chrome` entries are intentional
transcript no-ops, not visible UI implementations. Claude task registry/settled
bindings remain for older replay; current child work uses its canonical event.
Unknown tuples have no application semantics, though bounded diagnostics and
the [replay observer](../../src-ui/src/hooks/orchestration/replay/observe.ts)
can report their absence.

The `_kiro` v3 spelling remains unbound because it has not been observed (a
source comment names the gap; no exported record does); it does not inherit
`_kiro.dev` behavior. The table carries no promotion metadata: a tuple's
binding says nothing about which canonical event, if any, should replace it.

[Exact-set tests](../../src-shared/__tests__/extension-notification-bindings.test.ts),
ACP mapper tests and UI handler tests check lookup and current handling.
Observation and pinned SDK contract tags are evidence pointers, not a fresh provider run.
Add or remove a tuple together with its actual handler and evidence; do not
replace exact matching with wildcard vendor routing.


## JsonFileMutationAuthority

**Purpose.** [json-file-storage](../../packages/shared/src/json-file-storage.ts)
provides whole-document publication and serialized read/modify/write.
`writeJsonFile()` writes the supplied value, optionally checking an expected
fingerprint. `mutateJsonFile()` reads under the path lock and passes the current
value to a synchronous updater. The guarded-read variant lets an owning service
supply its descriptor-based read inside that same lock.

**Commit and bounds.** Ordinary writes/mutations acquire the asynchronous
`${path}.mutation` lock and await publication before releasing it. A plain
whole-value write does not reread the target unless a fingerprint check asks
for that read. Publication serializes JSON, creates a same-directory exclusive
mode-0600 temporary file, writes and syncs it, then renames it over the target.
The rename commits the visible value. Directory sync is attempted afterward;
its failure does not turn already published bytes into a retryable failed write,
and the directory-sync helper is a no-op on Windows. This is not a tested
power-loss guarantee for every filesystem.

A caller-supplied `maxBytes` limits the serialized document; there is no default
byte cap. Serialization happens before that size check. Schema validation,
path/root authority and appropriate input limits remain with the owning service.
Updaters are typed synchronous and must not be asynchronous callbacks.
`mutateJsonFile` publishes the returned value even when it equals the fallback;
a no-op that must not create a file needs a conditional transaction instead.

**Composed callers.** `publishJsonFileWithOwnedLock()` deliberately acquires no
lock and does not verify that the caller owns one. Project, integration,
review-receipt, summary and operation stores compose their own broader
capability around it. Summary regenerate/dismiss/show use the same path lock,
including the read for conditional mutations; deletion must share the publisher's
lock. Integration configuration takes integration then credential ownership,
publishes secrets before references and retires old secrets after configuration
publication. CLI portability import awaits those same owners.

Two important exceptions explain why the function name is not enforcement:
[memory-adapter conversations](../../src-server/adapters/file/memory-adapter-conversations.ts)
use their own per-conversation in-process queue, not this cross-process lock;
the [telemetry disclosure receipt](../../src-server/services/usage-telemetry-service.ts)
is a complete value with no read-derived update, so concurrent publication is
last-rename-wins. Atomic publication prevents torn values; it does not by itself
prevent a read/modify/write race or coordinate other processes' queues.

[FileStorageAdapter](../../src-server/domain/file-storage-adapter.ts) and
[integration storage](../../src-server/domain/config-loader-storage.ts) are
concrete callers. [Contention tests](../../src-server/services/__tests__/store-async-lock-cutover.test.ts)
and [cross-process configuration tests](../../src-server/domain/__tests__/config-loader-storage.process.test.ts)
exercise their ownership and failure paths. The source ratchet rejects direct
synchronous file-lock acquisition in production server code; it is not proof
that every transitive startup operation is asynchronous. Keep the owning
transaction and await its result instead of adding a second mutation protocol.


## LocalSkillMutationAuthority and SetupImportEffectJournal

[Local Skill mutation](../../src-server/services/agents/skill-local-mutation.ts)
serializes writers to the same discovered directory. [Setup
import](../../src-server/services/setup/existing-agent-setup-import.ts) records each
intended effect and its recovery outcome instead of treating a whole import as an
all-or-nothing success.

**Intent and Interface.** `SkillService` owns one cross-process capability for every
local Skill create, update, rename, remove, revision read, create-if-absent, and
compare-delete. `ExistingAgentSetupImportModule` persists one bounded effect record for
every reviewed import item before it may publish a Skill, then exposes that journal as
the sole itemized receipt projection: relative source ID, reviewed target,
state/outcome, stable reason/repair codes, known canonical target revision, and
retryable rollback state—never source bytes or filesystem identities.

**Contract.** Capabilities are keyed by the discovered local Skill directory and
acquired in deterministic order for a rename, so ordinary, conditional, and registry
callers cannot bypass each other or deadlock. Registry providers write only to an
exclusive sibling stage; its bounded safe tree is validated and conditionally published
without replacing a target that another capability holder created. Create-if-absent and
compare-delete read their condition under that same capability. The canonical revision
is versioned and domain-separated, framing each sorted entry's type, UTF-8 relative
path, and content lengths/bytes; directory entries commit tree shape, and unsafe,
linked, oversized, or overly deep trees refuse revision. A two-file local publication
either completes or compensates its just-created package; a compensation failure is
indeterminate, never a false success. `expectedLocalSkillRevision()` is the pure
companion for recovery only when it has the exact canonical publication entries,
including directories; ordinary recovery reads the owned filesystem revision. A
target-review Interface issues an expiring witness for the exhaustive final target set
(including renames), binding each target's exact absence or revision before Apply;
changing choices resets it. Each reviewed item records source digest, adapter version,
intended target, and `pending` before moving through `applying`, `applied`, `skipped`,
`failed`, `compensating`, `compensated`, or `indeterminate`; pending recovery is failed
with `re-preview`, and applying is attributed only when the precomputed exact canonical
revision matches. Receipt reads and apply restart reconciliation inspect the canonical
Skill revision: incomplete publication is failed, a created package becomes applied with
its exact revision, and incomplete compensation is retained as an explicit indeterminate
item. Bounded receipt retention remains 64 entries/30 days. Workspace Skill lock paths
now follow the discovered Project directory; mixed old/new processes using the earlier
machine-root lock name do not share exclusion for those packages. This is a
same-protocol coordination guarantee, not an upgrade-wide filesystem lock.

**Seam, Implementation, callers, and tests.** `skill-local-mutation.ts` is the one local
writer/revision capability; `SkillService`, registry installation, and the setup-import
module compose it with their owned helpers and the guarded receipt-store Adapter.
Routes, React-free SDK transport, React query Adapter, CLI JSON, and the shared stepper
pass that canonical receipt through without client reconstruction. Focused evidence is
`src-server/services/agents/__tests__/skill-revision.test.ts`,
`src-server/services/agents/__tests__/skill-service-install.test.ts`,
`src-server/services/agents/__tests__/skill-service.test.ts`,
`src-server/services/setup/__tests__/existing-agent-setup-import.test.ts`, and
`src-ui/src/components/setup/__tests__/ExistingSetupImportStepper.test.tsx`. **Do not
reintroduce:** a setup-only lock, a conditional check outside the local capability,
direct import target writes, pre-effect consumption without a durable item record, a
terminal aggregate that hides an unresolved item, browser-invented receipt rows, or a
retry that assumes an `applying` effect did not publish.

## StationHomeArchive

**Purpose.** [StationHomeArchive](../../packages/shared/src/station-home-archive.ts)
backs `station home backup|restore`. Backup returns a schema-bound manifest
and a published directory. Restore validates that archive, replaces the selected
home under maintenance ownership and returns the retained previous-home path
when one existed. It copies the selected home, not external Git workspaces,
the entire Station root or an OS keychain. A separate update-backup schema
serves a launcher-run service's supervised update (#2675 D): it omits the
store registry's external paths, records symbolic links as links instead of
refusing them, and has larger default caps. Neither restore accepts the
other's backup; the traversal and caps below describe `home backup`.

**Ownership and backup.** [StationHomeLifecycle](../../packages/shared/src/station-home-lifecycle.ts)
tracks runtime owners by PID and birth identity and gives maintenance exclusive
ownership against cooperating runtimes. Dead owners can be reclaimed;
unverifiable owners remain fenced. Runtime publication makes bounded exact
birth-probe retries for its own PID before refusing startup; probes of other
owners do not retry or fall back to PID-only authority. The lease can represent
multiple runtime owners, while individual callers can impose stricter same-home policy.
[StationRuntime](../../src-server/runtime/bootstrap/station-runtime.ts) retains
its lease through persistence shutdown. CLI wrappers also check lifecycle
observations for useful offline diagnostics. These checks do not stop an
unrelated external writer that ignores Station's ownership protocol.

Traversal is sorted and rejects symlinks/non-regular entries. Defaults cap an
archive at 100,000 files, 20 GiB total and 2 GiB per file. Paths are segment
arrays, so a POSIX backslash cannot become a directory separator on import.
Declared volatile files are excluded. SQLite is checkpointed and integrity
checked before copying; backup does not advance the home schema. Each copied
file is checked against its size/hash and synced before the staged archive is
renamed into place. The manifest records schema, creation time, segments,
modes, sizes, hashes and total bytes. Mode preservation follows platform support.

**Restore and failure.** Explicit confirmation and an inactive home are required.
The owner validates the manifest and every archived/staged byte before
publication. It renames an existing home aside, then renames the staged home
into place. Each rename is atomic; the pair is not one filesystem transaction.
Publication/schema failure attempts rollback, and rollback failure remains an
error. Successful restore keeps the replaced home instead of deleting it and
records that recovery did not transfer execution authority.

EventStore and SchedulerLedger share the SQLite integrity policy before
schema/migration writes. A completed non-OK quick-check or explicit corruption
error is corrupt; lock, permission, I/O and unknown faults are unavailable.
Neither outcome authorizes an automatic reset.

[Archive tests](../../packages/shared/src/__tests__/station-home-archive.test.ts)
cover real SQLite round-trip, tampering, bounds, confirmation and publication
faults. Home-lifecycle process tests exercise runtime/maintenance exclusion.
The [operator drill](../guides/deployment.md#offline-home-recovery-drill) covers
restored Project/Task/room references and missing evidence. Those are offline
recovery checks, not cross-host execution fencing, tenant isolation or a live
workspace backup.

### Detached recovery candidate (fixture-first)

`stageStationHomeRecoveryCandidate()` accepts already-detached bounded UTF-8
JSON records and an absent output directory. It preserves original records as
mode-0600 `.payload` files beneath mode-0700 `inert-evidence`, verifies the file
set/hashes and returns a content-free plan. Its selected-field classifier does
not prove capture consistency or source schema. Credential payload records are
excluded, and ambiguous Agent records stay whole: dropping an external-engine
binding could otherwise change absence into Station-engine execution.

Every candidate remains `publishable:false`. It emits no active home marker,
configuration, Agent store or database; it has no CLI/apply caller. Unknown or
malformed records remain inert evidence. Interrupted/post-publication failures
can leave an inert artifact, so later use must revalidate bytes and acquire real
capture, destination, identity/account and import authority.
[Candidate tests](../../packages/shared/src/__tests__/station-home-recovery-candidate.test.ts)
exercise that archive entry point; they do not prove live-home capture,
hostile-filesystem containment or physical recovery under #1391/#1388.


## StationHomeRecoveryPreflight

**Purpose.** `station home recovery-plan` calls
[`inspectStationHomeRecovery({ homeDir })`](../../packages/shared/src/station-home-recovery-preflight.ts)
to inspect selected schema, Engine/Agent reference and owner metadata before a
possible recovery. The CLI requires an explicit home and avoids the normal
argument paths that create temporary homes or initialize keyring state.

**Observation, not permission.** The reader uses bounded no-follow reads and
runtime-home admission but never calls schema ensure, acquires a runtime or
maintenance lease, copies an archive, migrates data or launches a process.
Exact IDs are compared without guessing aliases. Historical, credential,
grant, scheduler and plugin payloads remain unopened where the catalog marks
them outside the selected-field inspection. Malformed metadata, unknown stores,
unsafe paths, changing files and bounds failures remain visible in the report.

The process-existence probe is `kill(pid, 0)`: it cannot establish process birth
or exclude a legacy owner. The report is explicitly non-atomic and always
`applyAllowed:false`. It neither rewrites/quarantines original payloads nor
authorizes a future import, Session resume or scheduled execution. Recovery
must acquire fresh ownership and validate the actual bytes at its own boundary.

The [CLI lifecycle wrapper](../../packages/cli/src/commands/lifecycle.ts) returns
the same report. [Preflight tests](../../packages/shared/src/__tests__/station-home-recovery-preflight.test.ts)
and the actual CLI fixture check selected fields, unsafe paths, privacy and
absence of writes/child processes/keyring setup. Keep conversion and publication
with the existing archive/schema/lifecycle owners; do not turn a readable marker
or a surviving PID into an apply token.


## ProjectFileTransactions

A Project can be renamed, changed, or removed while another request writes a Layout or document. This owner orders those operations so a late nested write cannot recreate a deleted Project. Start with the [transaction owner](../../src-server/domain/project-file-transactions.ts) and its [filesystem composition](../../src-server/domain/file-storage-adapter.ts).

Portable attachment uses `createProjectWithManifest`: the initial Project and
identity are prepared outside the visible catalog and their directory is
published once under the Project mutation lock. Existing or orphaned destination
directories are not overwritten. Known post-publication faults preserve the
applied result. `project-identity-service.test.ts` exercises visibility, retries,
faults, input capture and real checkout resolution through the filesystem owner.

**Interface.** `ProjectFileTransactions` is the single lifecycle authority for a Project tree. Callers create a Project, read a `ProjectStoredFileRevision<T>` or `StoredFileRevision<T>`, or request an intent-shaped nested record upsert/delete. A Project revision exposes its validated value and exact `replace`, `remove`, and `createLayout` capabilities. Its server-only `withCurrentRead` runs a callback against a captured Project value under the same revision lock; `replaceManifest` conditionally updates the sidecar. These are explicit storage-owner capabilities, not a general filesystem transaction API. HTTP callers receive none of them.

**Behavior.** One Station-owned, project-keyed lock outside the deletable Project tree orders create, update, delete, Layout, conversation, and document mutations across processes. Reads runtime-validate strict persisted schemas; only `ENOENT` means absent. Every revision snapshots its input, admits one exact transition synchronously, joins a concurrent duplicate intent without publishing twice, and rejects a different intent. Replace and remove compare the exact observed fingerprint after ownership. Layout creation is issued only by the Project revision whose validated agent scope, workspace, and namespace facts produced it, so a concurrent Project change conflicts before any Layout effect. Project deletion atomically renames the entire tree out of service before best-effort trash cleanup, so a nested writer ordered before deletion cannot resurrect it and one ordered after deletion is refused. Publication uses the shared same-directory sync-and-rename Adapter. A post-commit fault is classified by exact readback, and observer or cleanup failure cannot turn a committed effect into a retryable result.

**Code and evidence.** `FileStorageAdapter` composes one authority and exposes intent-shaped `IStorageAdapter` revisions to `ProjectService`, knowledge-namespace mutation, and Project routes. Plugin namespace convergence completes idempotently before catalog Layout creation; the subsequent Project revision binds every Project-dependent Layout decision. HTTP maps only typed absence to 404, exact conflicts to stable 409, and corrupt or unavailable storage to stable 5xx copy without filesystem diagnostics. Layout creation adds server-owned identity and timestamps before persistence. Real child-process ordering, same-capability concurrency, stale Project/Layout revisions, post-commit, strict-schema, non-file, and missing-file proofs live in `src-server/domain/__tests__/project-file-transactions.process.test.ts`, `file-storage-schemas.test.ts`, and the Project route/service suites. **Do not reintroduce:** route- or service-owned read/merge/save, direct recursive Project deletion, Layout-local lock files, permissive `JSON.parse` casts at persisted boundaries, treating schema or I/O errors as empty or 404, raw storage paths in API errors, request-supplied code or callbacks under lifecycle ownership, or nested record writes outside the Project lifecycle lock.

## ProjectIdentity

A portable Project ID names the same Project across local installations; it does not carry a checkout path or permission to run work. The [identity service](../../src-server/services/projects/project-identity-service.ts) connects that portable record to one local Project under its storage revision.

**Interface.** `ProjectIdentityService` exposes explicit read,
preparation, attachment, and guarded execution-root replacement operations over the runtime's existing Project,
manifest and storage owners. `ProjectPortableIdentity` is the closed public
identity/reference snapshot; `ProjectIdentityAssociation` names its portable ID
and the receiver's distinct local ID and slug. Existing Project IDs and history
are preserved. Changing `executionRoot` compares both the expected portable
identity and receiver-local Project ID under the current Project revision;
an exact replay writes nothing, and clearing removes only that selection.

**Behavior.** Reads do not backfill. Explicit preparation uses the current
Project-revision admission and creates only a missing sidecar. Attachment
validates its snapshot and any selected local directory, then requires atomic
Project/manifest creation from the storage adapter. Existing mismatched identity
or configuration is a conflict; unknown versions/fields, unavailable stores and
unverifiable directories are named refusals. A same remote or slug is not
membership, execution consent, a room locator or a history-merge instruction.

**Code and evidence.** Project routes inject the runtime-pinned stores
and checkout reader; no second store is constructed behind a route. The SDK's
React-free client methods validate responses and capture the original attachment
request before asynchronous work. `project-identity-service.test.ts` covers
real Git checkouts, real filesystem publication/faults, conflicts and the HTTP
surface; `client-project-identity.test.ts` covers the public wire consumer and
incompatible/changed responses. Physical multi-machine and independent-human
acceptance remain separate from these tests.

## StationKnowledgeMcpServer

The [Knowledge MCP factory](../../src-server/tools/station-knowledge-mcp-server.ts)
registers five read/capture tools through the shared caller-policy wrapper.
Station Control retains index rebuild, migration, and its compatibility search.
[Runtime routes](../../src-server/runtime/routes/runtime-routes.ts) admit only
loopback MCP requests with a credential for this server and enforce the Session
owner’s store access before reading or writing records.

Claude uses a session-bound in-process server. Native agents use the
[custodied HTTP bridge](../../src-server/runtime/mcp/station-knowledge-native-tools.ts)
inside the accepted authorized turn, while Codex and ACP use their existing
wire delivery channels with separate Knowledge credentials. SDK cleanup and
cancellation bound local waiting; they do not undo a write already admitted by
the store. See the [Knowledge guide](../guides/knowledge.md#agent-tools) and
[mounted owner/access evidence](../../src-server/runtime/routes/__tests__/runtime-routes-station-control-read-scope.test.ts).

## KnowledgeStoreProvider

**Purpose and interface.** `KnowledgeStoreProvider` registers roots and their adapters,
resolves a root by ID, and exposes the adapter that owns its records. It also publishes
notifications after mutations through its wrapped adapters. There is currently no
production subscriber that turns `onRecordsChanged` into index updates. It does not own
semantic retrieval or watch arbitrary external file edits; the separate index requires
its own write/rebuild path.

**Current behavior.** Roots are persisted through the injected storage adapter. The
built-in default-file and Obsidian adapters implement the checked-in Kit record
contract; the conversation adapter is a read-only projection of Session history.
Personal and Project are scope tags, not a universal uniqueness or authorization proof:
the registry can allocate suffixed personal IDs, and the conversation root also has
personal scope. The Settings card currently selects the first personal root. Root
removal clears the cached adapter, but there is no atomic replacement operation exposed
by this interface.

**Follow the code.** [The
provider](../../src-server/knowledge-store/knowledge-store-provider.ts) is constructed
by [service bootstrap](../../src-server/runtime/bootstrap/runtime-service-bootstrap.ts)
and passed into the store/record routes. [The guide](../guides/knowledge.md) explains
disk formats, setup, migration, and the separate index. [Provider
tests](../../src-server/knowledge-store/__tests__/knowledge-store-provider.test.ts),
[store-route
tests](../../src-server/routes/knowledge/__tests__/knowledge-store.routes.test.ts), and
[Settings tests](../../src-ui/src/__tests__/KnowledgeStoreSection.test.tsx) cover those
interfaces; they do not establish live external-provider behavior.

## SqliteVecIndexProvider

**Purpose and interface.** `SqliteVecIndexProvider` owns a derived vector index:
upsert/remove, scoped search, explicit root rebuild, and statistics. Callers supply the
store and embedder for a rebuild. Runtime composition selects this built-in index for
the store/index routes; the older `KnowledgeService` has a different,
configured-provider interface.

**Current behavior and limits.** One SQLite table contains partitions keyed by root ID.
A rebuild reads and embeds source records before deleting that root's rows. Embedding
failure therefore leaves the old partition intact, but a later write failure can leave
an incomplete rebuild: the replacement is not one atomic transaction. Changing vector
width recreates the whole table and clears all roots' rebuild timestamps. The index does
not record embedding-model identity, so a same-width model change needs an explicit
rebuild. The search route checks root access and re-reads each record, but combines its
current title/category with the cached index excerpt; it does not compare that excerpt
with the current body. A successful lookup therefore establishes neither text freshness
nor an active lifecycle state.

**Follow the code.** [Index
implementation](../../src-server/knowledge-index/sqlite-vec-index-provider.ts), [HTTP
callers](../../src-server/routes/knowledge/knowledge-index-routes.ts), and [runtime
composition](../../src-server/runtime/routes/runtime-routes.ts) show the ownership and
access checks. [Provider
tests](../../src-server/knowledge-index/__tests__/sqlite-vec-index-provider.test.ts),
[partition tests](../../src-server/knowledge-index/__tests__/partition-scoping.test.ts),
and [lossless-rebuild
tests](../../src-server/knowledge-index/__tests__/lossless-rebuild.test.ts) use
controlled records and embeddings. They do not guarantee equal ranking after a
model/source change or prove live embedding-service availability.

## KnowledgeFileTransactions

[KnowledgeFileTransactions](../../src-server/knowledge-store/adapters/shared/file-transactions.ts)
keeps Station file writers and recovery on one protocol. Ordinary locked reads can
repair pending work; the separate source-observation path deliberately cannot.

**Intent and Interface.** `KnowledgeFileTransactions.mutate(operation, body)` gives one
writable knowledge root a serialized publication capability. The callback uses the
coordinator’s checked read/write methods within its owned transaction context; it
receives no lock token, journal path or raw commit operation. `read` supplies the same
recovery gate to read-only work. The built-in Kit default and Obsidian adapters and the
project `KnowledgeDocumentFileTransaction` all use this one shared Implementation.

**Contract.** A Station-owned coordination directory under `STATION_HOME` holds
process-identity file locks keyed by each root's real path, device, and inode. This
serializes Station writers across processes without requiring write authority over the
root's parent or reserving a sibling pathname. Every acquired capability enters a
release-owned `finally`. A mutation stages every change, verifies its file, directory,
and observed legacy-source read set, then durably records one prepared rollback journal
before publishing authoritative record or document files first, metadata and derived
graph/alias/path indexes second, and removals last. The composed root's device, inode,
and real path are revalidated before lock acquisition and immediately before every
rename or unlink. Every replacement is same-directory temp write, file sync, rename, and
directory sync. A callback rejection publishes none of its staged changes; a partial
publication failure rolls back exact bytes. On the next locked read or mutation,
recovery preserves a prepared journal whose complete after-image already matches disk;
otherwise it attempts exact rollback. A committed journal needs cleanup only. A rollback
conflict or storage failure can leave the obligation for a later attempt rather than
proving cleanup succeeded. Recovery never overwrites bytes that match neither the
recorded before nor after hash; it fails closed as a conflict. Only `ENOENT` means
absent. Authoritative records, nested provenance and mutation logs, requested record
identity, document metadata identity/path relationships, and Obsidian path metadata are
runtime-schema validated; journal paths are canonical and unique under host-native path
rules (so POSIX backslashes remain literal filename characters). A corrupt journal or
authoritative file is unavailable, never an empty store. Derived indexes may be rebuilt
from validated records through the adapter's explicit reindex path. Symlinked roots,
directory entries, and publication paths are refused.

**Seam, Implementation, callers, and tests.** Each writable adapter constructs the
coordinator at its root and routes record, graph, alias, path, archive, relocation,
project-document content, project-document metadata, and authoritative directory-tree
reads through it. Project-document vectors are a post-commit derived Adapter effect.
Every vector carries the authoritative content hash; search, content reconstruction, and
injected context join derived hits back to transaction-gated metadata and reject a stale
or missing hash. Legacy metadata without a hash is not authority for vector text and
must be rebuilt. A vector failure cannot roll back or replace committed files, and
vectors remain rebuildable from those files. The public KnowledgeStoreAdapter and
API/SDK/CLI/MCP record verbs remain unchanged; storage conflict/corruption is projected
at the existing API boundary with stable copy. Real child-process crash recovery,
cross-process lock interoperability, conflict, journal corruption, publication-order,
root/path symlink, and post-commit ambiguity proofs live in
`src-server/knowledge-store/adapters/__tests__/file-transactions.test.ts`; adapter
contract and project-document service tests cover both caller families. **Do not
reintroduce:** adapter-local `writeFileSync`/`renameSync`/`unlinkSync`, raw
authoritative directory traversal, whole-file mutation without the shared capability,
treating permission/I/O/schema errors as empty, deleting an Obsidian source before
publishing its replacement, splitting project document content from metadata
publication, returning an unverified vector hit, mutating vectors before authority
commits, or storing authoritative knowledge only in the derived vector index.

## SharedWorkingState

**Purpose and interface.** [SharedWorkingState](../../src-server/domain/shared-working-state.ts)
owns converged text for one exact Project/Task/document. `createSharedWorkingState()`
separates untrusted `live.apply(operation, authorization)` from the adapter-owned
`recovery.replay()` and `recovery.reconcile(currentGrant)` ports. Live results
are `applied`, `duplicate`, `deferred` or a named rejection. Trusted replay can
also return `replayed`; missing dependencies can still defer. The text,
content-addressed revision, snapshot, compaction and resync APIs expose document
state without granting transport, storage or participant-directory authority.

**Invariants.** Version-one operations require well-formed Unicode and exact
document identity. Actor ID and current writer epoch are checked before live
duplicate/defer decisions and again when deferred live work is released.
Same operation ID with a different digest is `operation_equivocation`.
Authoritative replay of an identical deferred operation promotes it to trusted;
recovery without a current grant leaves live obligations pending. Causal parents,
predecessor atoms and tombstones determine ordering, not wall-clock timestamps.
Display labels and Session/run correlations are attribution, not authorization
or convergence identity.

Pending IDs, digests and admission class contribute to revision/checkpoint
identity. A snapshot preserves pending obligations and validates its claimed
revision on restore. Rejecting deferred live work invalidates the affected
replay window; resync returns a snapshot rather than an impossible delta.
Deferred count/byte and replay limits bound those windows, not total process
memory for an indefinitely growing document. Presence and cursors never enter
the durable document facts. The [design record](../design/shared-working-state.md)
explains mechanism choices and historical constraints.

**Current composition.** [ProjectTaskRoomWorkingState](../../src-server/services/orchestration/project-task-room-working-state.ts)
and its worker own private SQLite settlement and snapshots. They instantiate
the live-only `SharedWorkingState`; no production caller composes the
`createSharedWorkingState()` recovery ports yet. [ProjectTaskRoomRuntime](../../src-server/services/orchestration/project-task-room-runtime.ts)
supplies current authority and projects text/revision through the closed browser
contract. This persistence adapter exists today. The browser neither owns an
operation factory nor receives the atom graph.

**Evidence and limits.** `src-server/domain/__tests__/shared-working-state.test.ts`
checks permutations, duplicate and delayed delivery, compaction, snapshot/delta
recovery and stale/malformed authority. Room working-state/runtime suites test
the persistence composition separately. These are first-party document
contracts, not compatibility evidence for a third-party CRDT wire format.
`station.shared_working_state.operations` emits bounded operation/outcome labels.


## LiveWorkSession

**Intent and Interface.** `LiveWorkSession` owns one bounded, deterministic
ephemeral projection for an exact Project/Task/surface/session. Its public
Interface is join, heartbeat, explicit announce/withdraw/depart, watch, follow,
local input, typing, bounded material replay, projection, revision reference,
and system-authorized export/restore/recovery. Server identity/work and revision
authorities supply attributable product facts. Actor-facing operations re-evaluate
authorization, with independent join/read/write/watch/follow/announce/history-read
capabilities.

**Contract.** No current liveness is reconstructed from replay or recovery.
Private participants are self-only; only a confirmed announcement publishes
targetable state. Explicit departure removes presence; TTL expiry is applied
when the caller supplies time to an admitted operation or projection. The pure
module does not run its own wall-clock timer. Both retain a recoverable material
closure. One announcement owns one canonical closure and reserves its worst-case
count/bytes before publication. Fixed-size
IDs digest an explicit ordered scalar projection including durable occurrence
and request identity. Only indeterminate intents remain pending; terminal facts,
dependencies, ordinals, reservation, terminal-linked self-contained replay, and
safe clock survive a bounded, server-authorized restart record. Actor and recovery
retries have separate rate budgets. Revisions require exact resolver-owned ID/Project/Task/session/run
evidence. Missing Adapters fail before creating/restoring an obligation.

**Current composition.** `ProjectTaskRoomRuntime` constructs the live session,
binds server identity/grant resolution, persists private recovery records and
projects browser-safe presence. It does not restore participants as live after
a restart.
`ProjectTaskLiveWorkHistoryAdapter` is the history seam: it consumes only
`ProjectTaskRoomAuthority` plus a server grant issuer, revalidates an actor/scope/
capability grant for every append, and maps stable live intent IDs to room proposal
IDs. Its async settlement path projects exact committed or duplicate room receipts;
denied/rejected results refuse by named reason, while malformed/throwing/unavailable
results remain indeterminate. It owns no EventStore, worker, SQLite, route, or
transport. `src-server/domain/__tests__/live-work-session.test.ts` and
`src-server/services/orchestration/__tests__/project-task-live-work-history-adapter.test.ts`
are the focused contract evidence. **Do not reintroduce:**
an API/database/UI here, a second message/presence log, caller-authored actor/work
facts, insertion-order IDs, authority inferred from replay, or restored liveness.

## ProjectTaskRoom

**Mounted Task path.** [TaskWorkspaceView](../../src-ui/src/views/TaskWorkspaceView.tsx)
mounts `ProjectTaskRoomProvider`, `ProjectTaskRoomPresence`, `TaskRoomEditorPane`
and `ProjectTaskRoomConversation` through `WorkspacePaneHost`.
[ProjectTaskRoomRuntime](../../src-server/services/orchestration/project-task-room-runtime.ts)
owns server edit planning, request/principal checks, per-subscriber projection,
ephemeral cursor limits, working-state settlement and history composition.
The [route](../../src-server/routes/orchestration/project-task-rooms.ts) emits
closed browser DTOs; exact-order document events take priority over queued
presence events without bypassing the final currentness check.

Personal runtime composition also mounts the
[TaskRoomWorkModule](../../src-server/services/projects/task-room-work-module.ts),
a separate Station-wide JSON journal for explicit agent requests. It reserves
an execution identity before existing delegation runs, rechecks Task/Project
incarnation and requester authority, and never re-invokes a recorded operation.
The delegation route supplies a private admission that OrchestrationService
rechecks at provider start and initial-turn effects. The same private admission
supplies the existing room-execution binding so source seals and pending-work
joins cover independent room sessions. Known authority loss uses
clean pre-effect refusal; unknown failures retain uncertainty. The
[composer](../../src-ui/src/workspace-panes/TaskRoomComposer.tsx) selects exact
agent recipients and uses the [scoped SDK hooks](../../packages/sdk/src/query-domains/taskRoomWork.ts).
Ordinary composer messages also use captured transport authority and an expected
Task incarnation that the history grant rechecks before commit. Request cards
currently poll the journal read and link to existing execution
inspection; they are not room-SSE lifecycle events. Invited/public result
projection and actual-provider acceptance remain unfinished.

Immutable output review uses the same room history, rather than a second
feedback journal. [TaskOutputModule](../../src-server/services/projects/task-output-module.ts)
validates fresh version targets against retained output and Task/Project identity;
permanent room identities resolve exact duplicates before output validation.
A per-room SQLite format fence prevents v2 writes after v3 adoption.
The [output surface](../../src-ui/src/views/task-workspace/TaskOutputsSection.tsx)
checks authorized downloaded bytes before offering a human review statement.
Reviewer acceptance changes no Task or workflow state. Source and focused
contract evidence do not establish a two-human or installed acceptance journey.

The [SDK](../../packages/sdk/src/client/project-task-rooms.ts) parses opaque
edit receipts and the shared SSE stream. Accepted document objects are offered
synchronously to mounted listeners before the same object enters query-cache
normalization. The [editor](../../src-ui/src/workspace-panes/TaskRoomEditorPane.tsx)
keeps unsaved text and an exact possible-effect receipt locally. It uses host
and navigation close guards, rechecks Task/authority generations after awaits,
and recovers from authoritative reads. A query gap or unavailable/error state
revokes edit authority even when previously applied text remains visible.
Terminal streams clear live presence; reconnect, duplicate/gap handling and
Task changes use the authoritative recovery path. Unsaved browser text is not
a durable server operation, and closing a stream does not undo a submitted edit.

**Evidence.** Room-runtime, working-state, route and SDK tests cover the
production composition. Mounted
`TaskRoomEditorPane.cache-integration.test.tsx` and `ProjectTaskRoomContext.test.tsx`
cover shared document delivery and recovery. `tests/project-task-room-collaboration.spec.ts`
is the two-browser acceptance route; a unit-test run is not that acceptance run.

The pure `CollaborativeEditorPaneController` that [the #2890 design](../design/collaborative-editor-pane.md) describes was deleted: no pane host, catalog entry, or route ever composed it, and its own tests were its only callers. **Do not reintroduce:** editor-local CRDT/OT/LWW logic, client-owned authority, exported pending payload, opaque-epoch freshness guesses, JSON metadata equivocation, per-cursor document copies, caller-asserted revision verification, local paths, capability conflation, durable chat/history ownership, host placement policy, or renderer-specific transport.

## SharedWorkingStateEditingCapability

**Purpose and interface.** [The editing capability](../../src-server/domain/shared-working-state-editing.ts)
turns a desired text value and selection into exact operations over a private
SharedWorkingState snapshot. `plan({ currentText, desiredText, selection, pending })`
returns unchanged, a bounded refusal, or a frozen batch. `projectPending()`
replays those exact operations; `transformSelection()` maps exact atom
boundaries through pending batches. Neither is an independent text-rebase
algorithm.

**Planning rules.** The capability restores and validates the snapshot, applies
pending batches, and requires the resulting text to equal the supplied editor
base. It clones actor/attribution data and maps UTF-16 selection boundaries to
Unicode scalars and visible atoms. Deletions name exact atoms; remote atoms
inserted later are not swept into that deletion. Insertion names the exact
predecessor. Where immutable RGA sibling ordering would put a retained suffix
before the inserted text, the planner reinserts that suffix to obtain the
requested text. Applying the resulting batch to a cloned document must reproduce
the desired text before the plan is accepted.

Deletion operations are chunked by measured JSON UTF-8 bytes, replacing the
older fixed 128-atom limit. [Shared limits](../../src-shared/collaborative-edit-limits.ts)
bound each operation to 256 KiB, the sum of operation bytes to 96 MiB, and a
batch to 384 operations. Text has separate 256 Ki code-unit and 256 KiB UTF-8
limits; atom IDs and selections are checked too. These are admission ceilings,
not a promise that every maximum-sized edit has acceptable interactive latency.

**Callers.** `ProjectTaskRoomRuntime.editPlan()` and `publishAgentDocumentEdit()`
use this capability on the server. Browser edits receive an opaque intent ID
and digest plus text/selection preview, never atoms, operations or a writer
grant. The runtime keeps at most 256 private plans, expires a plan after five
minutes, and settles only its exact scope/principal/digest. If the in-memory
plan is absent, submit can read an already durable matching receipt; it cannot
reconstruct an unsubmitted plan after restart.

**Evidence.** `shared-working-state-editing.test.ts` checks Unicode, exact
preview, byte chunking, insertion ordering, deletion, clone ownership and
selection transforms. `project-task-room-runtime.test.ts` checks the production
server composition; mounted Task editor tests check opaque receipt handling.
Keep those layers distinct when changing planning, retry or browser payloads.


## RevisionEvidenceModule

**Purpose.** [RevisionEvidenceModule](../../src-server/domain/revision-bound-evidence.ts)
freezes a settled `SharedWorkingState` snapshot into an immutable,
content-addressed Station receipt. `revision()` reads a defensive copy;
`resolveEvidence()` and `resolveGateInput()` report `AVAILABLE`, `UNAVAILABLE`
or `UNVERIFIED`. Those names describe binding/availability, not a Surface
assessment, Flow gate verdict, Survey decision or Veritas readiness result.

**Identity and attribution.** Freeze restores the untrusted snapshot through
SharedWorkingState and refuses deferred causal work as `pending_state`.
A required server-owned authority derives actor and correlation from the exact
Project/Task/document scope, shared revision and request identity. Caller
attribution is ignored. The module computes its deterministic identity first;
the authority then attests that exact identity, parents, scope, actor and
canonical payload. The attestation cannot change the revision ID. Parents and
proposed-change before/after pairs must have the same scope.

`resolveProposedChange()` uses an injected lookup of the existing change owner;
it does not create a second change lifecycle. Without that lookup it returns
`UNVERIFIED`. The production room bridge currently supplies attribution only
and exposes no proposed-change resolution operation.
With the lookup present, it checks canonical decision shape, transitive ancestry,
exact correlation and snapshot content. Its diff preserves the owner's supplied
snapshots/hashes rather than inventing another hash convention.

**Persistence and limits.** Defaults admit 256 revisions, a 4 MiB portable
bundle, 512 KiB snapshots, 256 KiB text and 768 KiB records; identifier, label
and attestation sizes have separate limits. Import checks entry count before a
cycle-safe escaped-JSON byte traversal, then validates identity, restored state,
parent closure, scope and every authority binding as one batch. Arrays/objects
and nested byte budgets are bounded, including sparse arrays and surrogate
escaping. Missing compatible attribution is `attribution_unverified`; a portable
file alone grants no trust. Returned records, exports and projections are cloned.

[EventStore](../../src-server/services/orchestration/event-store.ts) composes the
[SQLite persistence adapter](../../src-server/services/orchestration/sqlite-revision-evidence-persistence.ts).
It preflights count/text/byte limits before 32-row restore pages. A validated
ledger digest is rechecked under `BEGIN IMMEDIATE` before batch persistence;
a stale witness/response-loss path gets one bounded retry. Current persisted
reads refresh canonical truth. Registration precedes callback-bearing restore,
and lifecycle generations fence every external callback and successful
projection so reentrant close cannot refill or disclose a closed module's cache.

**Production connection.** [ProjectTaskRoomRevisionEvidenceBridge](../../src-server/services/orchestration/project-task-room-revision-evidence-bridge.ts)
uses bounded freeze grants and domain-separated EnvironmentSecurityService HMAC
attribution in the personal Task room. After an authorized working-state commit,
it freezes that exact private snapshot and publishes a scope-bound revision
link. Evidence failure adds an explicit gap without overturning the edit receipt.
Its reader omits full snapshots and attestations; it is not a general ledger
CRUD/import endpoint. Room shutdown closes the bridge before EventStore.

[Domain tests](../../src-server/domain/__tests__/revision-bound-evidence.test.ts),
[SQLite tests](../../src-server/services/orchestration/__tests__/revision-evidence-persistence.test.ts),
and [room composition tests](../../src-server/services/orchestration/__tests__/project-task-room-revision-evidence-bridge.test.ts)
cover identity, authority, bounds, restart, witness races, corruption and
reentrant close. Keep this receipt owner separate from mutable buffers, text
convergence and downstream verdict semantics.


## ActionOperationModule

**Purpose.** [ActionOperationService](../../src-server/services/operations/action-operation-service.ts)
adds a small durable Activity record around an existing operation. Tasks,
Sessions, runs and domain receipts still own the work itself. The service
provides creation, revision-checked update, authorized get/list/watch and a
cancellation interface. Records use typed domain references/re-entry targets
and bounded progress, with account and optional machine/Session scope.

**Storage and observation.** FileActionOperationStore locks the existing JSON
path, reads inside that lock, derives a cloned ledger and atomically publishes
before returning. There is no process-local authoritative ledger cache.
Defaults allow 25 active rows, 25 retained terminal rows, 50-item pages and a
512 KiB store. List ordering follows creation; watch ordering follows
actor-visible changes. This prunable Activity ledger is not an execution or
evidence archive.

Authorized reads can persist a stale-operation progress change: after 30 minutes
without an update, an active visible row receives `reconciliation-required`
and a new revision/change sequence. It does not become failed merely because
it is old. This is durable observation maintenance, not a purely in-memory
projection. Store/schema failures do not become an empty trusted history.

**Cancellation and active callers.** A supported cancellation needs an adapter
for the exact domain kind and only becomes cancelled after that domain reports
its durable result. A concurrent completion is reread inside the transaction.
The current [StationRuntime composition](../../src-server/runtime/bootstrap/station-runtime.ts)
supplies no cancellation adapters, so its tracked operations declare cancellation
unsupported; the generic interface is not a working universal stop button.
Runtime passes one service to authenticated routes, conversation fork, attached
Session handoff and fleet observation. [Request authority](../../src-server/services/operations/action-operation-authority.ts)
derives the account/machine scope and current Session-read check.

[FleetDispatchActionOperationObserver](../../src-server/services/operations/fleet-dispatch-action-operation-observer.ts)
starts from exact authorized account/Session/correlation identity. The active
row does not yet have a routing receipt; settlement adds the sealed receipt ID
before terminal publication. [Tracking helpers](../../src-server/services/operations/action-operation-tracker.ts)
use stable handoff identities and catch observation-storage failures so those
failures do not replace the wrapped domain result. The SDK/Activity UI consume
these browser-safe records, not the private file store.

The [Activity section](../../src-ui/src/components/action-operations/ActionOperationsSection.tsx)
keeps platform actions separate from filtered sessions: operation records have
account and optional machine/Session scope, without the Project or client-origin
attribution those filters need. Its disclosure shows running and attention counts,
opens for work needing attention, and keeps recent history collapsed separately.
Terminal operation status owns the outcome text; retained progress does not make
a succeeded, failed or cancelled operation read as still working. Active
`reconciliation-required` operations remain visible as needing attention.

[Service tests](../../src-server/services/operations/__tests__/action-operation-service.test.ts),
[tracker tests](../../src-server/services/operations/__tests__/action-operation-tracker.test.ts)
and [fleet-observer tests](../../src-server/services/operations/__tests__/fleet-dispatch-action-operation-observer.test.ts)
cover concurrency, authorization, publication faults and cancellation races with
fixtures. Do not add caller-created rows, arbitrary URLs, global watch cursors
or claims that an Activity status independently proves the underlying work.


## OperationalEventOutbox

**Purpose.** This is a durable journal for operational facts, separate from
chat's orchestration-event stream. `append(envelope)` returns `appended`,
`duplicate`, `rejected`, or `unavailable`. The separate reader's
`readAfter({ afterJournalSequence, limit })` returns an ordered page, its
retention gap when applicable, or a typed rejection/unavailability.

**State and boundaries.** The [outbox](../../src-server/services/operational-events/operational-event-outbox.ts)
validates and clones the registered envelope and rejects ephemeral delivery.
Its [SQLite adapter](../../src-server/services/operational-events/sqlite-operational-event-outbox.ts)
uses the existing EventStore database. SQLite assigns `journalSequence`;
a producer's own `sequence` is not this cursor. Event-ID tombstones survive
payload pruning and restart, so reuse of an ID is a duplicate rather than a
second append. This is identity deduplication, not a promise that two payloads
with the same ID are compared as equal.

The default window retains the newest 1,000 payloads; identity tombstones are
not pruned with that window. Reads default to 100 and admit at most 1,000 rows.
Bounds and rows come from one SQLite snapshot. Reads recheck stored identity,
payload size, JSON and the full envelope schema. Corruption produces
`unavailable`, not a trusted partial page. An old cursor receives the earliest
available sequence as an explicit gap. Append and consumer-specific gap facts
commit together before old payloads are removed; post-commit ambiguity uses
exact readback rather than blindly appending again.

**Current callers and evidence.** [EventStore](../../src-server/services/orchestration/event-store.ts)
exposes separate publisher and reader capabilities. The production publisher
in [StationRuntime](../../src-server/runtime/bootstrap/station-runtime.ts)
currently records `ready` and `stopping` lifecycle facts. The registry also
admits a Workspace Pane lifecycle type, but a declared type does not establish
a production producer. A successful append wakes the internal EventBus;
listener failure cannot change its durable result. The
[general event route](../../src-server/routes/orchestration/events.ts) does not
broadcast the scoped operational-event channel.

[Outbox tests](../../src-server/services/operational-events/__tests__/operational-event-outbox.test.ts)
exercise real SQLite validation, deduplication, retained identities, readback,
corruption and replay bounds. Keep persistence before notification and keep
the reader's gaps visible. The journal is not an in-memory EventBus history or
a guarantee that a subscriber processed a fact.


## OperationalEventDelivery

**Purpose.** Delivery turns the operational journal into a durable cursor and
retry stream for one declared consumer. `EventStore.openOperationalEventConsumer(config)`
returns a private capability with `claim()`, `deadLetters()` and `close()`.
A claimed event carries a stable idempotency key and attempt; only that claim
can acknowledge it, request a retry or dead-letter it. Gap acknowledgement is
a separate opaque capability, not an arbitrary cursor setter.

**State and boundaries.** The [consumer owner](../../src-server/services/operational-events/operational-event-delivery.ts)
validates the consumer ID, up to 32 event types and up to eight required scopes.
Reopening an ID with different normalized policy conflicts. The
[SQLite adapter](../../src-server/services/operational-events/sqlite-operational-event-delivery.ts)
checks those policy rows and claims/advances under `BEGIN IMMEDIATE`. A gap is
recorded only for pruned events matching that consumer's type and scope filter;
nonmatching history does not manufacture a gap. Claimed envelopes are checked
again before exposure.

Each capability has a process/birth owner. A live or unprobeable owner remains
fenced; a dead or explicitly closed owner can be reclaimed. Retry starts at
one second and doubles, capped at 60 seconds. At most five delivery attempts
are admitted; the next eligible reclaim after exhaustion dead-letters instead
of invoking a sixth attempt. The first settlement intent fixes its action,
receipt identity and retry time, so retrying a storage failure does not change
the intended result. A transaction receipt preserves exact readback across
commit ambiguity and temporarily fences another claim until resolved.

The store admits at most 64 consumer identities and retains the newest 100
dead letters per consumer. Closing releases process ownership; it does not
delete the persisted consumer policy. Neither payload pruning nor delivery
cleanup discards the outbox's event-ID tombstones.

**Current callers and evidence.** [EventStore](../../src-server/services/orchestration/event-store.ts)
composes and tracks these capabilities over its existing database. The active
[subscription registry](#operationaleventsubscriptions) wraps them for installed
plugin observers; registration is no longer merely future work. HTTP, SDK,
CLI and plugin callbacks do not receive a raw consumer or settlement methods.

[Delivery tests](../../src-server/services/operational-events/__tests__/operational-event-delivery.test.ts)
cover real SQLite filtering, contention, process death, post-commit readback,
retry exhaustion, gaps and capacity. Subscriber effects are at-least-once:
a crash after invocation but before settlement can repeat the same event.
Consumers must deduplicate its stable key. Do not replace this journal with an
in-memory retry queue or silently skip a relevant retention gap.


## OperationalEventSubscriptions

**Purpose.** A subscription combines a declaration, host policy and an observer
without giving the observer delivery authority. The
[registry](../../src-server/services/operational-events/operational-event-subscriptions.ts)
returns `dispatchOne()` and `close()`. Observer input contains a selected
projection, stable idempotency key, attempt and AbortSignal—not a claim,
cursor, gap acknowledgement or database handle.

**Authorization and projections.** Admission snapshots the declaration and
host authorization. Policy is checked again before claiming and immediately
before invoking. A changed consumer/projection or denial retires the
subscription. Unavailable policy before claiming performs no claim; if the
second check becomes unavailable after claiming, that claim schedules a retry
without invoking the observer. Analytics declarations require redacted
identity/type/time metadata without payload, scopes or correlations.
Sandboxed-plugin declarations require metadata without payload; an authorizer
cannot widen either class to a full envelope. These are API projection rules,
not a process sandbox.

**Delivery and recovery.** One subscription dispatches at a time, with a
maximum 30-second observer deadline. Accepted results acknowledge; explicit
retry or thrown observers schedule a durable retry; rejection or malformed
outcomes dead-letter. Close before invocation records a pre-invocation retry.
Timeout or close after invocation fixes a dead-letter settlement. Storage
uncertainty retries that settlement, not the observer. An abort-ignoring Promise
keeps this subscription busy and its owning registry/EventStore close pending
until it settles. This fence is local to that owner: after the terminal
settlement, a separately opened registry for the same consumer can claim the
next event while the first observer is still running. It is not a global
execution lock across registries. A process crash can also redeliver an
unsettled event, so observer effects must use the stable idempotency key.

Retention gaps remain visible, and subscriber code cannot acknowledge them.
`close()` reports `closed`, `pending` or `unavailable`; callers must honor that
result before treating replacement or shutdown as complete.

**Active composition.** [StationRuntime](../../src-server/runtime/bootstrap/station-runtime.ts)
starts [PluginOperationalEventSubscriptionService](../../src-server/runtime/plugins/plugin-operational-event-subscriptions.ts).
It reads installed manifest declarations, checks the current artifact and
`plugin.server`/`events.subscribe` grants, and additionally requires
`events.read-payload` for an envelope. It derives the consumer identity from
the plugin/subscription identity and gives each subscription its own dispatch
queue. Install/update/removal/grant events reconcile that set. Replacement
quiesces subscriptions before server modules and releases those barriers in
reverse order after publication or rollback. Other declaration classes are
supported by the registry contract; this is the current production registrar.

[Registry tests](../../src-server/services/operational-events/__tests__/operational-event-subscriptions.test.ts)
and [plugin composition tests](../../src-server/runtime/plugins/__tests__/plugin-operational-event-subscriptions.test.ts)
cover authorization, projection, revocation, settlement, observer fences and
replacement. They do not establish arbitrary plugin cooperation or exactly-once
external effects. Keep grants with the host and keep unresolved close results
visible.


## KnowledgeSourceObservation

[The observation
policy](../../src-server/knowledge-store/knowledge-source-observation-policy.ts) and
[exact source route](../../src-server/routes/knowledge/knowledge-source-routes.ts) let
the local operator inspect one canonical record without read repair or invented learning
state.

**Intent and Interface.** The existing `KnowledgeStoreProvider` owns
`observeExactRecord(rootId, recordId, authority)`. It defaults to `restricted` and
admits only an exact target approved by its constructor-captured host policy, rechecked
before file access and before returning content. Caller-supplied booleans,
principal-shaped objects, localhost, and registry membership do not confer access. The
runtime captures a personal-root policy requiring a real middleware-bound local-operator
Request: an internal principal or a credential with home possession. It also requires
personal runtime/request context, current credentials and route scope, an exact route
target, and the matching registered root incarnation. The source-observation GET and SDK
query feed the Memory record browser's optional host action and source-only dialog. No
project-root authority or ordinary-get fallback is inferred.

**Contract.** The first slice supports only registered built-in `kit-default-store`
roots and exact path-safe record IDs, not alias/prefix resolution.
`FileStorageAdapter.observeKnowledgeStoreRoots()` reads bounded registry bytes without
repair or bootstrap. A separate construction-free observation port inside
`KnowledgeFileTransactions` shares the writer's journal/lock identity rules. It opens no
journal/lock payload, acquires/reaps no lease, launches no process, and writes no data,
events or indexes. Any observed transaction artifact, unsafe path, corrupt data,
detected replacement, or exceeded budget refuses the read. Every existing ancestor and
leaf identity is checked; leaves must be regular, single-link files, opened
no-follow/nonblocking and read with a fixed byte budget. The shared YAML codec applies
parser depth/alias/merge limits; bounded schema validation checks exact filename/id
before projecting only source fields.

**Truth boundary.** Before/after checks are not an atomic filesystem capability or
snapshot; an intervening transaction may start and finish between checks. Every result
therefore declares `consistency: non-atomic`, unknown transaction state and unknown
owner revision. Its content digest/time describe Station's observation, never owner
revision, commit proof or mutation CAS. Record type/provenance/status retain published
meanings; absent status stays absent. No source text becomes instruction, candidate,
approval, activation, deployment scope, evaluation or effect evidence. Unsupported,
restricted and unavailable outcomes carry no record identity or payload.

**Seam and tests.** Real registry → provider → canonical-file proofs live in
`knowledge-record-observation.test.ts`; actual writer lock/journal interoperability and
a real FIFO swapped at native open live in
`knowledge-record-observation.process.test.ts`. Only synthetic disposable fixtures are
used. Windows FIFO behavior is explicitly not verified. The public
LearningSourceObservation shape is explicitly source-only and does not populate the full
LearningReviewProjection below. Production-constructor/authenticated-route proofs are in
knowledge-source.routes.test.ts; managed-browser desktop/mobile viewport and
replacement-root acceptance is in `tests/learning-source.spec.ts`; this is separate from
physical mobile-device qualification. **Do not reintroduce:** ordinary read-repair under
a read-only name, private Kit imports, raw route-owned file reads, inferred learning
lifecycle, caller-created authority, unbounded scans, or an atomicity claim based on
absence of a journal.

## LearningReviewProjection

**Status and purpose.** [The learning-review
contract](../../packages/contracts/src/learning-review.ts) defines a read-only,
owner-supplied lifecycle projection. It is retained contract work: no runtime producer
or mounted view supplies the complete projection. The earlier
`learningReviewViewModel()` and its unmounted UI were deleted. The working
[source-observation path](#knowledgesourceobservation) returns a separate
`LearningSourceObservation`; it does not populate missing lifecycle stages.

**Declared semantics.** The seven stages are source, candidate, evaluation, decision,
activation, effect and retirement. Available stages carry exact owner references;
absent, restricted, unavailable, corrupt and unsupported-version states carry no stage
value. Approval and activation are different facts. Activation needs its exact revision
and contribution disclosures; retirement has a separate owner receipt. Empty effect
observations mean not observed, never success. The historical view-model design required
mixed or unresolved observations and retirement gaps to remain visible rather than
converting them into a positive outcome. Those presentation rules are requirements for a
future consumer, not calculations currently performed by Station.

The TypeScript unions describe identity and access-state boundaries. This file is not a
runtime parser for arbitrary incoming data. A future owner adapter must validate those
boundaries before presentation, including exact revision references and explicit
activation/retirement/effect evidence. No Station learning ledger, text-similarity
inference or mutation authority follows from these types.

**Current integration limits.** The installed Flow Agents package has a CLI-generated
workflow-learning projection, explicitly non-authoritative, but its stable
`console-contract` export does not publish that shape. Its portable Kit observability
contract admits a `learning` kind with owner-defined data. That is not the full Station
lifecycle projection or a Knowledge Kit activation contract. Promotion, rejection,
rollback and retirement UI remain unwired.

**Evidence.** `packages/contracts/src/__tests__/learning-review.test.ts` checks the
schema/version and seven-stage constants plus typed restricted/unavailable examples. It
does not test a runtime validator, live owner integration or lifecycle presentation.
Source-observation owner, route and SDK tests establish only the separate source-only
feature.

## PluginCompositionModule

[PluginCompositionModule](../../src-server/services/plugins/plugin-composition.ts) is a
retained server-side composition mechanism, with fixture callers and no production
profile loader or activation route. Its guarantees describe the injected authorities
below, not the current global plugin provider registry.

**Intent and Interface.** `createPluginCompositionModule()` accepts one named Project-
or Agent-scoped profile and publishes a generation only after every selected
contribution has been authorized and staged. Contribution-instance identity binds
profile, scope, plugin, contribution, and local instance while configuration has a
separate content digest, so reconfiguration preserves identity without sharing state
across scopes. `inspect(scope)` projects active, pending, failed, and explicitly
shadowed contributions without exposing staged handles or disposer authority.

**Contract.** Each capability has one selected provider; multiple implementations
require an explicit selection and remain visible as shadowed. Exact-version dependency
edges are resolved inside one profile scope, topologically staged, and rejected before
activation for cycles, incompatible versions, duplicate local instances or plugin
contribution identities, invalid selections, or cross-scope references.
`station.identity`, `station.authorization`, `station.evidence-admission`,
`station.receipts`, and `station.event-store` are fixed host authorities and cannot be
provided by a profile. One whole-plan authorization lease binds every selected
declaration to its exact plugin owner, installed generation, and host staging factory; a
missing, mismatched, malformed, or stale binding cannot stage or publish. Host
capability wrappers preserve their original receiver. The prior generation remains
active through staging. Every staged handle receives a unique host-owned occurrence
lease, and the Module fences all prior or rollback occurrences synchronously before any
disposer begins. A failed stage, malformed-but-disposable stage result, or changed plan
lease reverses acquired handles, while a successful stage publishes the next generation
synchronously before retiring the prior generation in deterministic reverse dependency
order. Shared handle or disposer identities cannot be claimed by a second scope, so
retiring one Project cannot cross-dispose another Project's occurrence. Every selected
contribution remains visible after whole-plan refusal or rollback. Disposal is
deadline-bounded; an unresolved disposer remains visible by exact generation and
instance, and that identity cannot be reused until settlement. Activation attempts
serialize per scope and release their chain on settlement. Retained scopes are bounded;
`retire(scope)` closes a scope, disposes its active generation, and releases its
retained state when no disposal fence remains.

**Seam, Implementation, callers, and tests.** This retained #1362 component is
server-internal and composes one whole-plan authorizer whose granted lease carries
host-owned installed-contribution factories; it adds no manifest field, persistence,
route, SDK, CLI, UI, provider registry, hook registry, or Session override. Those later
adapters must stage behind this generation boundary rather than registering directly.
Focused proof lives in
`src-server/services/plugins/__tests__/plugin-composition.test.ts`, covering scope and
occurrence isolation, owner-qualified bindings, exact authorization outcomes, stable
identities, dependency restoration, cycle/version/scope refusal, shadowing, fixed
authorities, atomic rollback, synchronous fences, reverse disposal, live fences,
shared-handle refusal, and concurrent activation ordering. **Do not reintroduce:**
mutable global registration, plugin-owned generation numbers, implementation-only
factory lookup, per-contribution authorization snapshots, implicit provider choice,
cross-scope lookup, replaceable trust authorities, disposal in dependency order, or
staging that mutates the active generation.

**Admission and retirement receipts.** A retained-scope capacity refusal returns a
transient inspection of the requested selected and shadowed contributions, with
`scope-capacity` on blocked selected rows, without retaining another scope or invoking
the authorizer. Retirement remains `pending` while lifecycle or disposal fences survive,
including failed disposers; only settled cleanup reports `retired`. Queue admission
bookkeeping settles before that completion receipt becomes observable, so freed capacity
can be reused immediately unless a queued successor already owns it.

**Authorization cleanup custody.** Every owned authorization release uses one memoized
actual operation, including published generations, missing bindings,
recognizable-invalid grants, late authorization, and rollback. A bounded wait does not
erase that obligation: `authorization-release-pending` or `authorization-release-failed`
remains inspectable, retains scope admission, and keeps retirement pending until actual
release succeeds. Published contributions remain available during this cleanup debt.
Rollback releases only after all owned disposers settle successfully; unleased denial
creates no release obligation. Public fence lists are snapshots, and simultaneous
release/disposer failures remain separately visible.

Empty profiles still pass through whole-plan authorization and can retire a prior
generation. With no selected contribution, retained authorization or release debt is
projected in `inspection.scopeLifecycle` with its exact scope generation, status, and
reason; contribution rows and `liveFences` remain contribution-only, never synthetic
placeholders. Late authorization hands that scope diagnostic to the actual release
owner, and it disappears only on proved settlement. Configuration validation checks
remaining structural key/node capacity before sorting object keys or collecting array
descriptors, including extra array properties; accessors, symbols, and non-data
structures remain refused.

**Captured authority, bounded configuration and disputed resources.** Construction
captures the exact data-method authorizer and original receiver, including prototype
methods, without executing accessor capabilities or unrelated getters; later
options/method replacement cannot change the trust authority. Configuration
canonicalization counts JSON-escaped UTF-8 bytes incrementally before sorting keys or
allocating a complete serialization, including punctuation, control escapes and lone
surrogates. Oversized configuration is not retained; bounded declaration metadata still
projects every selected contribution on refusal. Structural/malformed-profile refusal
remains separate. Intrinsic own-key enumeration and hostile synchronous Proxy traps are
not preemptible by these data bounds.

An exact handle already in host custody is borrowed, not a newly acquired resource: a
late borrowed return completes its staging obligation and releases only that plan's
lease after all earlier rollback settles. A distinct handle sharing an owned disposer is
different. Its real handle/capability, exact handle identity, and whole-plan
authorization remain retained with `staged-resource-conflict`; admission and retirement
stay pending. The active owner's occurrence is neither fenced nor disposed by that
conflict. A separate disputed-disposer reservation survives retirement of the original
active claim, so fresh handles cannot adopt that cleanup function while disputed
resources remain. Retirement of the original disposer owner does not silently authorize
cleanup or adoption of the disputed resource. This tracer has no separate recovery
authority for that case and must not manufacture cleanup success.

Late null/undefined/primitive returns settle the no-returned-handle obligation, just
like rejection, without releasing ahead of earlier rollback or actual lease cleanup.
Invalid object/function returns are not proof of absence: ordinary and late paths retain
the actual opaque value, its identity and lease with `staged-resource-ambiguous`,
without invoking unknown cleanup capabilities. Recognizable disposers still follow
normal rollback; disputed identities retain their separate fences. Retained ambiguous
resources remain bounded by the existing per-scope admission gate and cannot be silently
adopted by a later scope.

## PluginGrantReconciliation

[Grant reconciliation](../../src-server/services/plugins/plugin-grant-reconciliation.ts)
updates runtime contributions after a permission decision. [Plugin
routes](../../src-server/routes/plugins/plugins.ts) compose its real module,
subscription, provider and connection adapters.

Whole-registry reloads capture their candidate resolution, registry epoch, and complete
home-bound grant-state fingerprint under one grant read lease. That lease is released
before importing plugin code. Publication checks the captured grant fingerprint again
under the ordinary grant publication lease before any registry mutation, including empty
generations and absent-plugin-directory clears. A changed grant snapshot refuses the old
reload and retains cleanup ownership of its staged resources; it cannot bump a newly
granted source's generation and strand the newer reconciliation. The fingerprint proves
current state equivalence, not a monotonic grant revision or detection of every
intermediate ABA transition. An unavailable grant store refuses the reload without
inventing an empty authority set.

Provider publication additionally acquires the same cross-process grants-store lock used
by revoke, rebind, approval, and restoration writes. It re-reads effective
`providers.register` under that lock and retains it through the provider registry
commit. The common install/rollback loader and bootstrap/full reload use this same
authority; source and whole-registry generation checks refuse staging superseded during
preparation, and refused adapters retain exact cleanup ownership. Reconciliation
additionally encloses preparation and publication in the installed-content lease. This
orders publication against durable grant writes even before the route resumes to advance
its in-memory reconciliation generation. This does not claim synchronous retirement of
already-published providers in another runtime.

Response-independent reconciliation starts without inherited re-entrant content-lock
context. Its authority-bearing adapters acquire the same actual content mutex for their
complete preparation/publication span. A caller that still owns a live content guard
receives `winding-down` immediately, allowing the consent decision guard to release
without a forced deadline wait; the retained work then owns its own lease. Ordinary
awaited nesting remains re-entrant, and callers outside a live guard retain the fast
completed-response path. This is cooperative, process-local exclusion, not cross-runtime
package coordination or a sandbox for arbitrary plugin background work.

**Intent and Interface.** `PluginGrantReconciliationService.reconcile({ pluginName,
permissions })` converges the runtime generation for one installed plugin after its
durable grant state changes. It returns `completed`, `superseded`, `incomplete`, or
`winding-down` with a stable operation identity and generation; it never rewrites the
grant store.

**Contract.** Reconciliation is serialized per plugin and bound to the exact installed
content generation. A newer revoke, regrant, update, or removal supersedes stale work
rather than letting it publish over the newer generation; the newer operation inherits
the complete pending lifecycle-permission vector, so a disjoint grant change cannot
abandon earlier provider, module, or subscription cleanup. Revoking event authority
first quiesces and closes that plugin's operational-event consumers; revoking server
authority advances the existing module-generation fence and drains active leases.
Provider revocation atomically removes only that plugin's registrations, waits for
provider-adapter retirement, and removes its engine connections while holding both the
exact installed-content lock and provider-generation CAS; a replacement cannot publish
between the final check and connection deletion. Regrant holds the same
content-generation lock through manifest read and provider preparation, then publishes
only while both its reconciliation generation and exact provider-source generation
remain current at the synchronous registry commit boundary before reconciling
connections. Independent cleanup stages continue after a sibling failure and report
their exact bounded stage names. The HTTP response waits for a bounded interval; work
exceeding it stays owned by the service and returns `winding-down` rather than a false
completion. Releasing subscription quiescence is followed by an awaited reconciliation,
so the revoke path never relies only on the EventBus observer. Trusted-approval records
retain the exact reconciliation projection after they become approved, rather than
leaving it only on a transient event.

**Seam, Implementation, callers, and tests.** Runtime route composition supplies the
existing plugin-module quiescence, operational-event subscription quiescence/reconcile,
provider registry, Adapter retirement, and engine-connection Adapters. Both direct
revocation and the distinct-origin trusted regrant path invoke the same service. The
Plugins surface renders terminal, winding, and incomplete truth with an actionable
idempotent check/retry path. Adversarial evidence covers drain ordering, disjoint
supersession, stale revoke/regrant generations, content-locked activation,
content-generation replacement, timeout ownership, partial failure, retained consent
projection, durable-write-before-retirement, and truthful HTTP 200/202 projection in
`plugin-grant-reconciliation.test.ts`, `plugin-installation-generation-fence.test.ts`,
`plugin-public-routes.test.ts`, and `plugin-host-approval-routes.test.ts`. **Do not
reintroduce:** grant-route provider mutation, fire-and-forget subscription retirement as
completion evidence, unbounded response waits, source-wide provider clearing,
implementation import outside the content-generation lease, or cleanup that can publish
after its installation generation was replaced.

## PluginCommandEffects

**Intent and Interface.** A plugin command row in the palette is not authority (kontourai/station#1418). `createPluginCommandEffectAdmission().admit()` admits one argument-free `navigate` or `seed-composer` effect for one browser document and returns a receipt whose effect content Station read from the installed declaration. `PluginCommandEffectService` owns the durable ledger in the Station home (`plugin-command-effects.json`): `recordAdmission`, `settle`, `beginWithdrawal`, `withdrawal`, `listWithdrawals`, `listUncapturedEffects`, `awaitWithdrawal`, `resolveWithdrawal` and `abandonEffect`. Wire shapes, including the operational event's data, live in `@kontourai/station-contracts/plugin-command-effect`.

**Contract.** Linearization points (kontourai/station#1419): LP-A is the atomic ledger append of an `admitted` effect, reached only after visibility (an invisible plugin is refused as absent), then inside the plugin content lock the installed artifact, exact generation, declaration, target and requirements (a session the caller can read; project and task existence), a fresh currentness check, for `plugin-server` commands the grants read lease, and finally the request-window check at the append. LP-W is `beginWithdrawal`, called after an authority change is durable and under the serialization admission of that authority uses: uninstall (including owned-dependency removal and install rollback) and install-over inside the install transaction's content locks, the legacy update route inside its content lock, and `plugin.server` withdrawal after the grants write admissions append inside. A plugin has at most one open withdrawal; a later change joins it, so a withdrawal is never refused for capacity, and a change is never vetoed or rolled back by ledger trouble (it reports `commandEffectsUnavailable`). LP-K is the atomic settlement write: first terminal outcome wins, the same outcome is idempotent, a different one is a counted 409 conflict, and a cancel before any admission is kept, never displaced, until no matching admission can still be accepted. LP-C is a ledger read finding a withdrawal with nothing outstanding. `closed-indeterminate` derives only from the withdrawal's own operator resolution. Request identity, cancels and settlement are scoped to the caller's principal and document key. Bounds refuse growth and never evict outstanding effects or open withdrawals; every write is measured with the writer's own serializer, and a ledger at every bound fits under the growth limit. The audit event follows the ledger commit; a crash between them loses the event, not the record. The ledger lock is always taken last.

**Seam, Implementation, callers, and tests.** `routes/plugins/plugin-command-effect-routes.ts` is the HTTP seam; `plugins.ts` composes it with principal resolution, plugin visibility and the `commandEffects` options `runtime-routes.ts` supplies (hosted-deployment check, the runtime operational-event audit publisher, `createPluginCommandRequirementResolver`). Hosted deployments, and a composition without those options, refuse every route; admission, `resolve` and `abandon` also refuse non-person callers. `plugin-install-transaction.ts`, `plugin-lifecycle-routes.ts`, `plugin-public-routes.ts` and `plugin-host-approval-routes.ts` call `withdrawPluginCommandEffects`; lifecycle, install, registry and grant routes call `settlePluginCommandEffectsForResponse`, and `GET /api/plugins/host-approvals/:id` re-reads the withdrawal from the ledger. The UI uses the built-in palette's page-placement path for region-surface destinations and checks the ordinary navigation guard before route destinations; a blocked route settles `aborted` rather than opening an asynchronous confirmation. Ledger invariants, bounds, coalescing, scoping and fault-injected commits are in `plugin-command-effects.test.ts`; the real withdrawal paths against forced interleavings are in `plugin-command-effect-lifecycle.test.ts`; dependency capture is in `plugin-install-transaction.test.ts` and `plugin-managed-dependencies.test.ts`. **Do not reintroduce:** a palette row or cached intent as effect content, an audit event as the admission record, eviction of outstanding effects or unexpired cancels, a second open withdrawal per plugin, a lifecycle change refused because its withdrawal could not be recorded, a withdrawal reported complete without settlement proof, or a lifecycle response that waits while holding a plugin lock.

## RegistrySupplyChainPolicy

[Package verification](../../src-server/services/plugins/registry-supply-chain.ts) and
[acquisition receipts](../../src-server/services/plugins/registry-acquisition.ts)
connect the host's registry policy to the source bytes reviewed for installation.

**Intent and Interface.** `verifyRegistryPackage()` checks the source digest and
validates a declared or required Ed25519 signature against host-selected keys.
`registry-acquisition.ts` binds a configured profile's result to the applied policy
epoch and exact signing principal, or an explicit unsigned result when that profile
permits one. Public Node leaves own the canonical source-tree digest and signature
payload; the server keeps installed-root resolution in its existing wrapper.

A registry without a matching applied profile can take the compatibility path only
without a supplied claim or retained trust receipt. A claim with no policy is refused;
an existing verified installation cannot silently lose its trust continuity. Registry
discovery alone does not mean a package was signed.

**Contract.** Preview and the central installer obtain a fresh coherent host-provider
observation. Root and dependency consent carry an opaque trust revision. The existing
selected-generation journal binds the activation receipt digest; aliases cannot
authenticate or remove this binding. Exact replay remains supported, while changed
source/claim/key/policy continuity refuses with retained data. Offline recovery reuses
captured built bytes and original verification under the same policy, never a new
registry lookup. Source-tree and installed-artifact digests are distinct. Local
ready/pending/MCP admission checks the authoritative applied epoch; a candidate edit
alone is not completed withdrawal, and no check claims to terminate started effects.

**Seam, implementation, callers, and tests.** Runtime configuration publication,
registry resolution, preview/install/dependency/recovery routes, provider preparation,
and EventStore custody compose these owners. Signed graphs, alias/receipt loss, offline
recovery, stale preview, signing-key rotation, provider cleanup, and pinned-provider
startup are exercised by the registry policy, installer, loader, and cold-start tests.
The older alias-pin/LKG helper remains compatibility/tracer code, not the production pin
authority; its `invalidateExistingGrants` flag alone does not establish
signing-principal continuity. See [Applied registry trust
policy](../design/registry-trust-policy.md) for the supported profile and explicit
hosted/migration limits. **Do not reintroduce:** registry-supplied trust anchors, alias
authority, content-only signer comparisons, unchecked legacy dependency builds,
synchronous remote-cache revocation claims, or direct live-tree rollback.

## ReviewEvidenceModule

**Purpose.** [ReviewEvidenceModule](../../src-server/services/evidence/review-evidence-module.ts)
runs a review of one immutable Git base/head range and records attributable
findings. A caller supplies a request ID and one to eight reviewer declarations,
or requests server-owned Repo Map selection. Status/read/list are durable
projections. A completed request means the review workflow produced its receipt;
the receipt can contain failed reviewers and is never itself a gate verdict.

**Selection and execution.** The host resolves Agent identities, rejects
self-review/duplicate reviewer Agents, and pins refs such as `HEAD` before opening
the workspace. Unavailable Repo Map selection records `not-verified` before
allocating a workspace/executor. The current
[runtime composition](../../src-server/runtime/routes/runtime-routes.ts)
uses [OrchestrationReviewExecutor](../../src-server/services/evidence/orchestration-review-executor.ts)
with Codex. It checks the engine's native read-only declaration and injects
server-only review isolation at Session start and turn dispatch; orchestration
maps that to read-only sandbox/never-approve settings. Caller input cannot
supply that internal isolation field. Distinct Agent identities and these
settings do not prove independent reasoning or a correct finding.

A durable prepared/invoking record precedes execution. The same request ID joins
in-flight work or returns its existing status; possible invocation is not
replayed after response loss or dead-owner recovery. Reviewer timeout, malformed
output and failure are recorded explicitly, not converted to a clean review.
Finding validation checks schema and the exact file/line in the reviewed Git
head. Confidence and `reproduced`/`reasoned-from-code` are reviewer declarations;
this parser does not independently verify a reproduction command receipt.
Delta mode follows bounded receipt ancestry and checks that each claimed finding
is assessed exactly once.

**Storage and cleanup.** [GitReviewWorkspaceSource](../../src-server/services/evidence/git-review-workspace-source.ts)
serializes detached workspaces and defaults to eight retained workspaces. Git
location checks read exact blobs and reject symlink entries.
[FileReviewReceiptStore](../../src-server/services/evidence/review-receipt-store.ts)
owns request and content-addressed receipt publication under Project filesystem
authority. Default per-Project receipt capacity is 256; protected evidence is
not silently pruned to admit another request. Aggregate reads cap the Project
inventory at 256 and materialize the newest 512 receipts. They may repair the
reference index under its lock. Unreadable/contended Projects are reported;
a missing workspace contributes no receipts rather than proving it has none.

Confirmed-start shutdown failure and executor timeout retain the workspace.
There is a current exception: if Session start returns an indeterminate outcome
by throwing, the executor has not set its `started` flag, reports the workspace
safe and skips stop. The module can then close that workspace despite possible
live reviewer work. This path needs uncertainty propagation and confirmed
cleanup before the general retention guarantee can be claimed.

**Consumers and evidence.** API, SDK client, CLI and station-control MCP share
`REVIEW_EVIDENCE_OPERATOR_SURFACE`. Project Review UI uses that client; the old
global Review Queue is not its current route. SDK submission has a 30-second
transport bound and recovers/polls by request ID, respecting caller cancellation.
[Flow attachment](../../src-server/services/evidence/flow-review-evidence-attachment.ts)
uses `station.review-findings` with status `unknown`, never pass/fail/approval.

[Module tests](../../src-server/services/evidence/__tests__/review-evidence-module.test.ts),
[executor tests](../../src-server/services/evidence/__tests__/orchestration-review-executor.test.ts),
Git/store/route/SDK tests and the caller uncertainty probe establish specific
contracts. No live reviewer or native sandbox was exercised by this documentation
review. Keep model assertions, validated locations, execution evidence and gate
decisions distinct.


## VerificationCoordinator

**Purpose.** [coordinateVerification](../../scripts/lib/verification-coordinator.mjs)
coordinates a named verification lane across worktrees on one host. It can
execute, join or reuse matching work and return rejected/cancelled/timed-out
outcomes. `verificationStatus()` projects host scheduling state;
`explainVerification()` shows the request, lane, receipt destination and status.
Callers use these operations rather than mutating leases or output ownership.

**Identity and admission.** [Request identity](../../scripts/lib/verification-request-identity.mjs)
owns coordinator roots, request/output/receipt paths and execution-equivalence
keys. [Request context](../../scripts/lib/verification-request-context.mjs)
validates lane/time/capacity, binds revision/worktree and exact Node/npm toolchain
provenance, and checks a submitted request at admission. Provenance is checked
again before execution and each non-reused completion phase. A same-name lane
or green sentinel alone is not reusable evidence.

[Lease ownership](../../scripts/lib/verification-lease-ownership.mjs) owns atomic
lease changes, exact process liveness, output fences, cleanup/recovery and
finished-lease retention. [Admission](../../scripts/lib/verification-admission.mjs)
applies weighted/FIFO/host-pressure rules through that capability; it cannot
execute commands or publish receipts. Host verification pressure is separate
from the product's diagnostic CPU posture and cold-start lease.

**Execution, reuse and publication.** [Completion phases](../../scripts/lib/verification-completion-phases.mjs)
validate checkpoints and run ordered full-regression phases without taking a
second parent lease. Execution lifecycle, terminal-receipt publication, artifact
projection and submission have their own owners. Output remains fenced until
terminal publication and cleanup establish their required facts. Local receipt
reuse normally reads; an invalid reusable-output receipt can instead be quarantined
and replaced with a tombstone under a narrow artifact-mutation fence.
[Fast diagnostics](../../scripts/lib/verification-ci-fast-diagnostics.mjs)
attach changed-test evidence by digest/provenance without scheduling another run.

The [command entry point](../../scripts/run-verification.mjs), submission worker,
stress runner and status CLI compose this interface. The local coordinator
supports diagnostic and explicitly requested completion work; canonical release
promotion evidence comes from the exact-SHA hosted workflow described in
[Testing](../guides/testing.md). Neither a joined run nor a structural gate says
more than its actual selected checks establish.

[Coordinator tests](../../scripts/__tests__/verification-coordinator.test.ts)
and [terminal-receipt tests](../../scripts/__tests__/verification-terminal-receipt.test.ts)
exercise leases, same-worktree coexistence, phase reuse, cancellation, deadlines,
FIFO and publication failures. An import-direction check keeps the extracted
modules from importing the coordinator back; it is a structural check, not
proof of semantic completeness. Keep identity,
lease mutation and receipt construction with their single owners, and do not
bypass an output fence or add recursive command-entrypoint imports.


## RuntimeResourcePostureController

**Purpose.** [Resource posture](../../src-server/services/infra/resource-posture.ts)
separates diagnostic CPU observations from engine-start admission. `observe()`
returns raw busy percentage, sample time/age, logical CPU count and descriptive
healthy/degraded/critical/unavailable classification. Concurrent readers join a
sample; recent readers reuse it. The sampler computes busy time from two
`os.cpus()` snapshots separated by its configured interval.

`reserveEngineStart()` is a different capability: one in-memory lease per
controller instance. It does not sample CPU. `admitEngineStartForIntent` retains
server-derived intent labels but does not use them or CPU posture to prioritize
work. Other Station runtimes have their own controllers; this is not the
verification coordinator's host-wide scheduler. A competing cold start can
receive `resource_engine_start_capacity` until the existing lease settles.

**Composition and limits.** [Runtime initialization](../../src-server/runtime/bootstrap/runtime-initialize.ts)
creates the controller and supplies it to orchestration and the diagnostic route.
[OrchestrationService](../../src-server/services/orchestration/orchestration-service.ts)
holds start leases around the provider boundary. Foreground/delegation/webhook/
recovery composition derives intent; clients do not mint a posture override.
The developer System view reads the diagnostic projection.

Automatic Scheduler fan-out has its own deterministic published ceiling.
Excess initial occurrences are released; retries wait FIFO for invocation
capacity. Manual runs bypass admission but count while active. Neither this
ceiling nor the cold-start lease is a claim that the machine has enough memory
or that a provider will start successfully.

[Posture tests](../../src-server/services/infra/__tests__/resource-posture.test.ts)
and runtime/scheduler composition tests exercise progress at a synthetic
99-percent CPU reading and preserve the product/verification import boundary.
Keep CPU classification observational; do not make high load a hidden product
refusal, require an override token or import verification scheduling into the
application.


## OutboundDispatchModule

An offline message is a draft until transport may have started it. After that, the [durable browser queue](../../src-ui/src/lib/outboundQueue.ts) retains evidence instead of silently resending. The [flush hook](../../src-ui/src/hooks/useOutboundQueueFlush.ts) supplies the live conversation and send adapter.

**Interface.** `outboundDispatch.enqueue(intent)`, `flush(transport)`, `open()`, projection subscription, and the safe pre-effect `edit`, `retry`, `discard`, reorder, merge, and unmerge operations form the UI's durable outbound Interface. `flush` supplies a state-bound `OutboundDispatchClaim` to its transport Adapter. The adapter returns `accepted(providerTurnId)`, `not-invoked`, or `deferred`. The last two are pre-provider outcomes: `not-invoked` consumes an attempt, while a temporary `deferred` gate does not. After invocation it throws or records `indeterminate`. It receives neither IndexedDB storage nor a claim token, and callers cannot place a provider turn id on an intent.

**Behavior.** The Module persists `pending → invoking` before transport. An explicit `not-invoked` outcome may return an intent to `pending` or `failed`; `deferred` restores it to `pending` without consuming an attempt and blocks that Session for the current flush; accepted transport becomes `accepted` with its exact provider turn id. A structured foreground indeterminate outcome, any transport throw or abort after invocation begins, or any post-effect persistence uncertainty is `may-have-started` evidence. `invoking`, `accepted`, and `may-have-started` are non-replayable across renderer restart, block later work in the same session, and are never aged out or evicted. A full queue evicts the oldest ordinary `pending` or `failed` draft; protected evidence is never an admission victim. Exact `(sessionId, providerTurnId)` terminal evidence lives in the same locked durable queue state as its accepted row, is consumed once, and reconciles a persisted accepted/evidence pair on a later `open()` after an interrupted write; a bounded completed-tuple record ignores a duplicate terminal after that consumption. An older accepted row without a nonempty provider turn id migrates to `may-have-started` with an explicit migration reason, never a replayable public acceptance. A terminal never needs to be the currently open turn, but cannot settle a different session with a colliding provider id. Canonical `turn.started` has no provider-backed client correlation and never settles this Interface by session id. Error observers run only after claim classification and cannot undo it.

**Code and evidence.** The implementation privately composes IndexedDB transaction storage, optional Web Lock cooperation, renderer claim identity, pruning, and an in-memory fence for a same-renderer storage fault. `useActiveChatSessionMessaging` is the foreground/replay transport Adapter; `useOutboundQueueFlush`, queued-message controls, and terminal event handling use the same Module Interface. The local steer queue and durable outbound queue are optional ChatDock capabilities: both are dynamically composed only when queue state exists and share `QueuedMessages.css` beside those lazy components, so their code and styles do not consume the always-loaded entry budget. Evidence lives in `src-ui/src/__tests__/outboundQueue.test.ts`, `outboundQueueTerminalIntegration.test.ts`, `useActiveChatSessionMessaging.test.ts`, `OutboundQueuedMessages.test.tsx`, and `outbound-queue-css-boundary.test.ts`. **Do not reintroduce:** hook-local mark/release/accept writes, a DOM session-observation event, session-id settlement of a possible start, automatic retry/eviction of possible-effect evidence, or queue-only code/styles in the eager ChatDock/entry surface.

## StarterWorkRegistry

Starter Work guides a newly configured personal Station through five real actions. It remembers which exact Task, Session, approval, or receipt the action refers to, then reads the owning service for its outcome. The [registry](../../src-server/services/starter-work/starter-registry.ts) does not manufacture tutorial success.

**Interface.** `StarterRegistry` is the bounded Module for the five
post-first-run journeys: start a Task, continue a Session, inspect an approval,
inspect a review receipt, and run a scheduled readiness check. Its catalog,
candidate, launch, observation, and
clear Interfaces accept intent-shaped typed references; clients cannot add
starter IDs, hrefs, owner payloads, evidence, or completion facts.

**Behavior.** The correlation ledger stores only one exact reference and
operation identity per starter. Task and Session launches retain their existing
effect fences. Inspection candidates and observations are re-derived from the
Approval Inbox, Scheduler RunService, or ReviewEvidence owner; no local boolean
or copied verdict overrides those reads. Approval inspection never decides the
request. Independent-review receipts remain input-only evidence. Exact
Project-plus-receipt identity prevents cross-Project collisions, and hosted
execution exposes no Starter route until equivalent tenant owners exist.
The scheduled-check launch prepares one Scheduler-owned run, binds its exact
receipt, and only then activates the opaque capability; completion never
becomes a pass verdict.

**Code and evidence.** Runtime composition builds the
registry only after the shared Notification, Run, and ReviewEvidence Modules
exist, then mounts one personal-only route family. The SDK owns HTTP and Home
offers guided actions with exact operation correlation; Notifications and Review Queue resolve server-built
deep links to the exact owner row. Contract, module, owner, route, runtime,
SDK, Home, Notifications, and Review Queue tests live beside those seams.
**Do not reintroduce:** a tutorial checklist store, synthetic approvals or
receipts, title-based selection, raw approval targets, a duplicate receipt
store, caller-authored href/evidence, or automatic action on inspection.

## NativeInvocationRuns

**Purpose.** Direct Agent invocation can return a result without creating an
orchestration Session. `NativeInvocationRuns` records that separate operation.
[EventStore](../../src-server/services/orchestration/event-store.ts) initializes
and reconciles the private owner before publishing `NativeInvocationStarter`
and `NativeInvocationRunReader`. `begin()` returns a canonical `invoke:*` ID and
an opaque claim, not SQLite or a global reconciliation API.

**Provider boundary and recovery.** The [run owner](../../src-server/services/orchestration/native-invocation-runs.ts)
persists `starting`, then `running` immediately before a possible provider call.
Only confirmed terminal persistence/readback permits a completed response.
A throw or configuration/settlement failure after that boundary is indeterminate,
including a local check after the provider returned. It has no automatic retry.
On startup, a dead starting owner becomes failed; a dead running owner becomes
indeterminate. Live or unprobeable owners remain fenced. Startup reconciliation
has a bounded retry gate and refuses construction if storage remains unavailable.
Terminal history retains 1,000 rows; active rows are kept independently.

**Actual callers.** The [invoke helper](../../src-server/routes/agents/native-invocation.ts)
wraps `generateText`/`generateObject` at the provider boundary. The
[Agent routes](../../src-server/routes/agents/invoke.ts) use it for
`/agents/:slug/invoke` and legacy-named `/agents/:slug/invoke/stream`; the latter
name does not turn its generated response into an SSE stream. [Global invoke](../../src-server/routes/agents/invoke-global.ts)
can have a completed primary text run and a separate structured-output run.
Its partial error keeps the primary ID and any real secondary IDs, with an
explicit `not_started` or `indeterminate` structure result.

The SDK's ordinary `invoke()` keeps its raw-result contract;
`invokeWithRunReceipt()` adds observation. A lost response is a possible effect
without an invented run ID. [RunService](../../src-server/services/orchestration/run-service.ts)
requires the reader and projects indeterminate as failed with unknown failure
kind plus `nativeInvocationState`. It deliberately omits invoke and voice
records for hosted tenant authority because those records lack tenant binding.
Recording a run does not grant invocation or read authority.

[SQLite/restart tests](../../src-server/services/orchestration/__tests__/native-invocation-runs.test.ts)
and [invoke route tests](../../src-server/routes/agents/__tests__/invoke.routes.test.ts)
cover boundary failures and response compatibility. Keep the durable boundary
beside the actual provider call and preserve uncertainty instead of retrying it.

### VoiceTurnRuns and correlated S2S v1

**Purpose and current path.** [VoiceTurnRuns](../../src-server/services/orchestration/voice-turn-runs.ts)
records provider-observed voice completions. This is post-effect observation:
`completionStart` means the provider has already begun. The base `IS2SProvider`
remains compatible with uncorrelated lifecycle and `toolUseId` events. A provider
opting into `S2SCorrelatedTurnsV1` supplies exact correlated start/end/tool facts.
The server [VoiceSessionService](../../src-server/voice/voice-session.ts), composed
in [runtime service bootstrap](../../src-server/runtime/bootstrap/runtime-service-bootstrap.ts),
receives the ledger. The browser voice registry and plugin clients do not.

The durable identity is the voice session, provider session, prompt and completion
tuple. Duplicate starts do not create another `voice:*` run. In correlated mode,
tool content must join that exact tuple and content ID before execution. Missing,
late, end-before-start or post-end correlation executes no correlated tool and
settles no unrelated run. Legacy tool events remain a separate unattributed path;
they are not evidence of a correlated turn.

The Nova parser emits provider identities; the Session service joins them to
private handles. A matching `END_TURN` becomes completed only after already
attached tool operations settle. A tool effect or acknowledgement that throws,
an unrecognized terminal reason, provider loss or dead owner leaves the result
indeterminate. A pre-effect denial/missing tool can be identified separately.
Teardown retains exact terminal obligations across storage unavailability; it
does not infer a turn from timestamps or substitute `toolUseId` as its identity.
These records describe observed provider boundaries, not audio quality or a
listener hearing the reply.

[Parser/Session/SQLite integration tests](../../src-server/voice/__tests__/voice-run-attribution.integration.test.ts),
[Session tests](../../src-server/voice/__tests__/voice-session.test.ts), and
[voice ledger tests](../../src-server/services/orchestration/__tests__/voice-turn-runs.test.ts)
cover correlation, ordering and recovery with fixtures. They are not a live
provider, microphone, WebSocket deployment or physical-device qualification.


## SchedulerLedger and BuiltinScheduler

**Purpose.** The scheduler owns jobs and durable attempts independently of an
open chat window. [SchedulerLedger](../../src-server/services/scheduling/scheduler-ledger.ts)
creates/edits/removes built-in jobs and issues `claimDue`/`claimManual` receipts.
Only the exact receipt can begin invocation, settle an attempt or advance a
proved pre-invocation failure. [BuiltinScheduler](../../src-server/services/scheduling/builtin-scheduler.ts)
executes those claims through a required `ScheduledTurnAdapter` whose result
is `completed`, `definitely-not-invoked` or `indeterminate`.

**State, retry and authority.** SQLite serializes claims and mutations across
processes. A stable `jobId` is distinct from the editable name; deleting and
recreating a job gives it a new scheduled-job principal. The due claim records
its occurrence and firing time. Terminal outcomes consume that occurrence;
manual runs do not advance the recurring cursor. Claim and `beginInvocation`
persist before their respective effects. A dead initial pre-invocation owner
can release its claim, while an advanced safe retry retains its run/attempt and
budget. A dead invoked owner becomes indeterminate and is never automatically
replayed. Exact revision checks let a concurrent job edit/delete win over old
completion. Post-commit uncertainty requires exact readback; unavailable storage
is a typed error, not an empty schedule or invented successful run.

Automatic invocations use the published
[`SCHEDULER_EXECUTION_LIMITS`](../../packages/contracts/src/scheduler.ts)
ceiling. Excess first attempts release their occurrence; durable retries wait
FIFO for an invocation permit. Explicit manual runs bypass this admission but
count while active. CPU diagnostics do not decide admission. This concurrency
accounting belongs to one scheduler process, while the ledger protects each
persisted job attempt across processes.

**Operator and internal interfaces.** Jobs accept `cron`, `every` or `at`
schedules; the legacy `cron` field remains for compatibility. The authenticated
scheduler routes, React-free SDK client, CLI and station-control MCP expose the
verbs in `SCHEDULER_OPERATOR_SURFACE`; scheduler SSE and the inbound webhook are
API transport surfaces. `SchedulerService` starts and registers the built-in
provider. `ISchedulerProvider` is an internal composition API, not a public
plugin scheduler-registration SDK. Manual outcomes carry a canonical
RunSummary ID when the owner actually created one; deferred provider output
cannot invent a receipt. In hosted mode, the
[scheduler route boundary](../../src-server/routes/operations/scheduler.ts)
refuses every read, mutation, SSE stream and webhook because scheduler storage
has no tenant binding. Hosted RunService reads also omit schedule records.

Starter Work uses `prepareStarterManualIntent` to bind one operation to an exact
run before activation. Its durable index admits 100 identities without eviction,
checks replay before capacity, and exposes activate/release only to the owner.
Pre-invocation restart reclaims that run; possible invocation stays indeterminate.
Recovery reads the stored Starter operation identity rather than reconstructing
one from a newer UI definition.

**Active composition and evidence.** [Runtime route support](../../src-server/runtime/routes/runtime-route-support.ts)
constructs SchedulerService after Agents exist, supplies notifications and the
scheduled-turn adapter, and derives the `{ kind: 'scheduled-job', jobId }`
principal through private async context. Omitted/legacy `default` selects the
public `station` Agent; the adapter alone maps it to the private runtime key.
The operator projection exposes the principal for standing-grant management,
but creation/update does not accept caller-declared execution authority.

External monitor jobs follow a separate path in the same owner: the
[monitor evaluator](../../src-server/services/scheduling/external-monitor.ts)
observes its configured source, and runtime support can create an idempotent
Task and dispatch it with explicit Project/Agent identity and monitor limits.
Missing authority or exhausted budget does not fall through to the ordinary
model-turn adapter. This path is not proof that an arbitrary external source
or provider is available.

[Ledger tests](../../src-server/services/scheduling/__tests__/scheduler-ledger.test.ts),
[execution tests](../../src-server/services/scheduling/__tests__/builtin-scheduler-execution.test.ts),
[monitor tests](../../src-server/services/scheduling/__tests__/external-monitor.test.ts)
and [service tests](../../src-server/services/__tests__/scheduler.test.ts)
exercise these boundaries. Legacy JSON import is one-time/atomic; corruption,
unsafe database/log paths and output symlinks are refused. Keep occurrence,
principal and retry identity in the ledger, and never replay an indeterminate
provider effect just to obtain a clean log.


## Whole Task Basis collection

Whole Task Basis shows the answers, tool results, and Process receipts deliberately kept with a Task. It does not combine them into one trust score. The [collection view](../../packages/basis-pane/src/task-basis-collection-view.ts) supplies Station’s navigation and labels; Surface supplies each answer’s meaning.

**Interface.** `buildStationTaskBasisCollectionView` in the first-party
Basis Pane package accepts an explicitly declared full authorized collection or
bounded page. It presents exact server-ordered answers, collection availability,
and unassociated kept items without an aggregate Task standing. Kept Flow gate
evaluations are a separate Process group: their original verdict and current
retained-bundle standing remain Flow-owned and do not become answer standing. Surface's public
`buildBasisPanelViewModel` owns every answer's standing, evidence partitions,
context notice, relationships, and gaps.

**Contract and Seam.** The `task-basis-mcp` contracts subpath parses and builds
bounded pages over an already-authorized `station.task-basis-collection/v4` value.
The native `StationBasisPane` consumes the shared collection view without the
portable page-size limit. Page offsets only describe an in-memory slice; they
are not authorization or a stable snapshot across owner reads. Network
continuation must separately pin the subject, reauthorize, and reject stale
collections. **Do not reintroduce:** Task semantics inside Surface, a synthesized
Task trust score, silent truncation, or first-page-only native browsing.

**Portable App seam.** `station-control/get_task_basis` serves static
`ui://station/basis/task/v3`. A private read session binds each bounded page to
the exact Task, caller, and authority. Opaque metadata continuations rotate,
expire, and revoke; only `BasisMcpWorkspacePane` composes the code-issued narrow
adapter, while all ordinary read-only App calls remain denied. The browser
replaces pages and delegates selected-answer semantics to Surface, never
fetching protected data or deriving Task standing.

**Exact execution seam.** `ConnectedStationBasisPane` supplies inspection and
type-specific Keep actions through the pane's public render slot. Surface's
public result ref and Thread's bounded inert projection remain the owners;
TaskGraph persists only the exact Session/event identity. A separate retained
result stream survives unavailable answers without implying semantic support.
The server rechecks retained links and every published result's Session access
after owner I/O, including kept-only MCP pages. SDK request scopes capture
Connect activation and native authorization epochs before scheduling; guarded
transport/body reads reject replaced authorities. Basis supplies an explicit
captured request scope. The SDK also guards same-origin requests when their
configured transport supplies a current-binding predicate, so native and relay
requests can have that guard without an explicit Basis request scope.

## Session inventory Sources

Sources explains the reviewed-source contribution to one exact answer. It is not a search across the Session or an inferred citation list. The [exact-answer owner](../../src-server/services/evidence/exact-answer-basis-module.ts) reads the evidence once, and the [inventory adapter](../../src-server/services/evidence/reviewed-source-session-inventory-adapter.ts) narrows it for display.

**Interface.** `ExactAnswerBasisModule` is the runtime-composed
point-read Interface for one authorized Session answer. It sequences Thread,
assessment, retained narrative, and reviewed-source owners once, fences
authority after every await, then returns the existing Surface Basis projection
and the exact reviewed-source contribution. `SessionInventoryModule` consumes
that result through the pure `ReviewedSourceSessionInventoryAdapter`; it never
opens a plugin, scans answers, or reads a whole Session to populate Sources.

**Contract and Seam.** Current-answer Sources contains at most one
`surface-answer-contribution`, with the exact reviewed ref plus closed review,
currentness, checked-at, and assessment-revision facts. `contributed-to` is
always explicit; support/citation/counter relationships are never inferred.
Whole Session and Kept-in-Task instead expose the closed
`session-source-index-not-captured` and
`task-source-provenance-not-captured` gaps. Runtime composition occurs after
the assessment/narrative/source owners exist and shares the instance with
orchestration and Task routes; `OrchestrationService` owns no Surface owner.
Without a tenant evidence composition, hosted reads can retain the authorized Thread answer while withholding personal assessment, narrative, and reviewed-source owners. The Sources group then reports the owner’s unavailable/not-captured state; it is not permission to load personal evidence or a blanket refusal of all answer data.

## TaskDispatcher and TaskGraph

A Task remains a durable work record before and after an engine runs. The [dispatcher](../../src-server/services/projects/task-dispatcher.ts) turns a dispatch intent into an execution attempt; [TaskGraph](../../src-server/services/projects/task-graph-service.ts) retains the Task, reservation, and resulting links. A dispatch receipt is not proof the Task succeeded.

**Interface.** `TaskDispatcher.dispatch(taskId, intent)` is the canonical Task dispatch Interface and returns a total tagged `DispatchOutcome`. `TaskGraphService` owns durable graph reads and transitions; it does not expose dispatch as a second caller Interface. Independent [Task room agent requests](../design/task-room-agent-requests.md) use existing delegation and retain their own executions without replacing the Task's current-session association.

**Behavior.** Dispatch accepts task identity and intent rather than a bag of graph/orchestration dependencies. It owns admission, scoped claim, workspace resolution, provider start or a seeded Session, deadline/abort settlement, telemetry, and release. A `dispatched` outcome may contain `outcome: seeded` without an engine start; read the result rather than treating the outer tag as completed execution. A missing task is `not-found`, not a duplicate/idempotency claim. When a provider claim may have succeeded after deadline, the result is indeterminate rather than retryable. TaskGraph graph mutations remain durable. Production composition supplies Project and workflow readers at construction; the constructor itself permits them to be absent, and dependent operations must report unavailable state or omit optional workflow correlation.

**Code and evidence.** `StationRuntime` composes `TaskGraphService` after concrete project and workflow dependencies exist, then publishes `composeTaskDispatcher(taskGraph, adapters)` to runtime routes and capabilities. The dispatcher Implementation owns private task-graph Adapter contributions. Evidence includes `src-server/services/projects/__tests__/task-dispatcher.test.ts`, `task-dispatch-composition.test.ts`, `task-graph-service.dispatch-claim.test.ts`, task route tests, and cold-start/runtime tests. See [Task dispatch](../design/task-dispatcher.md). **Do not reintroduce:** `TaskGraphService.dispatchTask`, post-construction project/workflow setters, or a route that reaches graph execution details directly.

**Close-out on merge (#3161).** A person can opt a Task in to closing when its pull requests merge (`TaskRecord.closeOnMerge`, `PUT /api/tasks/:taskId/close-on-merge`; no Station Control tool reaches that route). [`task-close-out.ts`](../../src-server/services/projects/task-close-out.ts) is a reconciliation, not a loop: when the conversation pull request refresh observes a merged pull request for a viewer holding the operate tier (the scope `PATCH /api/tasks/:taskId/status` needs; never a Station Control tool call), it reads each pull request kept on the Tasks that kept it, at its exact identity and four at a time, and `TaskGraphService.completeTaskOnMerge` moves a Task to `done` only if every kept pull request is `MERGED`, the Task is the same incarnation (`createdAt`) the reads were for, no pull request was kept since (matched by declaration and target, since one turn's declarations share an event), and `canTransitionTaskStatus` allows `done` (never from todo, ready, triage or blocked). A pull request closed without merging never completes a Task. Nothing re-runs it: a merge is noticed when an operate-tier viewer next refreshes that conversation, and nothing reconciles without one. A pull request declared through Station Control waits in memory for its turn's terminal event (a turn-lifetime lease, not the native 60 seconds) and is lost if Station restarts first. The tests in `task-close-out.test.ts` and `runtime-routes-declare-pull-request-engine.test.ts` cover it.

The Task dispatcher additionally composes a server-owned room execution
binding and the existing `SessionTurnBoundaryAuthority`. One durable
`task-dispatch` record spans external claims, provider creation, graph
association and publication preparation. Its session-start capability is bound
to the exact session and cannot release the enclosing dispatch. Provider exit
alone cannot retire that record. Ordinary start claims separately preserve
uncertain adapter creation without fabricating a turn ID.
`ProjectTaskRoomHistory.sealSource` reauthorizes a dedicated operator grant and
serializes its immutable intent/checkpoint with room commits, publication
queues and bound execution records. Both room workers enforce the seal in
their write transactions. This is a private source barrier, not an exposed
move command or external ownership lease. See the
[handoff design and remaining integration](../design/channel-home-authority.md).

## StationInstanceReconciler

**Purpose.** [StationInstanceReconciler](../../packages/cli/src/commands/station-instance-reconciler.ts)
coordinates an installed service toward `running` or `stopped`. `inspect(ref)`
is a direct platform observation and can reject. `reconcile()` classifies its
normal operation as converged, already-converged, not-installed, timed-out,
contended, partial or failed. Its observations include manifest, supervisor,
identity, readiness, ports and registry facts together.

**Coordination and deadlines.** In-process work is joined by `instanceId` and
desired state; an opposing request is contended. Each joiner can have its own
deadline. The platform adapter supplies the cross-process lock and OS actions.
`deadlineMs` is a duration converted to an absolute monotonic deadline, checked
around blocking phases. Omitting it creates no overall reconciler deadline.
The normal service command forwards its optional `installReadinessTimeoutMs`;
without an injected value it relies on individual platform/readiness bounds,
not this aggregate timer.

When an action may still finish after a deadline, the module keeps its shared
operation and filesystem lock until that action settles. It returns partial
uncertainty rather than issuing an opposing action. Immediate lock-release
failure changes the returned outcome; delayed release failure after a partial
result is logged because that result has already been returned. Only a coherent
absent installation is `not-installed`.

**Caller and evidence.** [CLI service commands](../../packages/cli/src/commands/service.ts)
compose launchd/systemd/Windows adapters and use this path for start/stop.
Status can call the direct read, while installation/uninstallation have their
own existing lifecycle—not every service operation is a reconcile call.
The public reconciler exposes no adapter AbortSignal or raw platform mutation.

[Reconciler tests](../../packages/cli/src/__tests__/station-instance-reconciler.test.ts)
exercise joining, opposing work, deadlines, delayed settlement and failures
with injected platform owners. Platform suites test their concrete projections;
neither establishes a live supervisor on this machine. Keep the exact instance
scope and uncertain settlement visible instead of pre-branching on a stale
manifest or adding an unrelated stop/restart path.


## Evidence-gated and retained internal work

### Project-resource resolver evidence: #1501 and #1775

The project-resource shadow report is an evidence gate, not a cutover signal. Its own
report says a passing record has no versioned current-resolver provenance and does not
cover caller-supplied-cwd precedence, the home/ACP terminus, or final effective-cwd
existence. Keep #1501 slice 3c and #1775 explicitly gated until a versioned
current-resolver observation and the remaining owner decisions exist. Do not use
accumulated shadow populations as proof that a resolver migration is safe. See
[`scripts/project-resource-shadow-report.ts`](../../scripts/project-resource-shadow-report.ts)
and [portable project identity](../design/portable-project-identity.md).

### #2525 retained internal boundaries

Turn deduplication, adoption, recovery, and private credential application are completed
behavioural ledgers. Remaining EventStore details are retained on purpose: command
receipts still participate in adoption's atomic commit; Console delivery progress uses
`readConsoleDeliveryProgress`/`writeConsoleDeliveryProgress`, consumed by
[ConsoleBridgeService](../../src-server/services/evidence/console-bridge-service.ts),
with monotonic SQLite advancement; and a broader session journal has no
deletion-complete caller family. Wrapping any of these in storage-shaped CRUD would be
shallow. Their disposition and the next evidence required for a deep extraction are in
[EventStore ledger migration](../design/event-store-ledger-migration.md).

## WorkspacePaneHostActions

`workspace-pane-host-actions.ts` projects the existing contribution contract and
transports already captured admission through bounded one-shot tickets. It does not
create another run database: Session commands and EventStore remain execution and
receipt authority. Tickets expire after one minute, are scoped to the request principal,
tenant and Project, and are removed before invocation. Missing/spent tickets are
indeterminate and never recreate work. Permission admission uses the canonical
grant-store read lease before the existing short Project/Agent locks; all three release
before network settlement. Public contracts expose intent and opaque installation
identity, never physical artifact paths.

`workspace-pane-host-actions.ts` routes are composed with the same request principal and
session read authority as foreground chat. SDK queries/mutations own HTTP and React
Query behavior. `AppViewContent` mounts `WorkspacePaneHostActionsFrame` around Project
Layout and direct Workspace Pane routes. It does not mount that bar around Task or
personal Board routes. A docked `LayoutWorkspacePane` has no prompt launcher; it reads
and navigates, as recorded in the [placement design](../design/placement.md).
`LayoutView` never launches plugin-owned actions through the unqualified chat path: safe
installed legacy declarations reuse captured host admission, while saved or unsupported
controls are review-only with an explanation. Non-plugin user-authored actions retain
their explicit Agent launch. Persisted Layout data is unchanged.

Native Agents use the existing runtime instance under a configuration lease, with a private relay companion
that is never serialized as Agent data. Native execution location has a separate private
ALS/cleanup scope, so ordinary later turns and child Sessions retain the persisted
directory even when optional output-declaration grants are unavailable. Canonical Git
path/branch and Session-derived ownership checks mint an opaque exact start binding for
a retained worktree; public metadata cannot supply that capability. The directory
reaches Project context, per-invocation Bash children, and relative file operations.
Known worktree Sessions require their private relay marker, and closed scopes refuse
late tool entry. Explicit MCP resource roots retain their configured meaning; this is
execution location, not a universal filesystem sandbox. Explicit `station-agent`
references in installed host contributions remain unavailable; this restriction does not
describe ordinary non-plugin chat or user-authored Layout actions. Tests cover
actor/Project isolation, duplicate delivery, final permission withdrawal, stale
installation/Agent identity, fixed bindings, public response certainty, and the real
host control surface.

## Cloud move preparation

The private [planned home transfer store](../../src-server/services/orchestration/planned-home-transfer-store.ts)
owns conditional ownership decisions. The
[paired authority](../../src-server/services/orchestration/paired-home-transfer-authority.ts)
binds those decisions to current authenticated participants, while
[remote room bindings](../../src-server/services/orchestration/home-transfer-room-binding.ts)
bind checkpoint observations to enrolled endpoints.

The [admission journal](../../src-server/services/orchestration/planned-home-admission-store.ts)
blocks transfer commits while effects remain unresolved.
[Control sessions](../../src-server/services/orchestration/planned-home-control-session-authority.ts)
own private session exclusivity and explicit control-grant checks;
[operator reconciliation](../../src-server/services/orchestration/planned-home-admission-reconciliation.ts)
settles existing admissions only through a trusted durable-receipt verifier. The
[room-write adapter](../../src-server/services/orchestration/planned-home-control-room-write-adapter.ts)
binds control-session authority to the private history port and owns cross-room
admission identity.
The [room receipt verifier](../../src-server/services/orchestration/planned-home-control-room-write-receipt-verifier.ts)
binds one canonical room-write admission and trusted home owner to an indexed,
integrity-checked EventStore receipt read. EventStore returns one immutable
receipt and its stored digest; callers receive no SQLite or receipt-list access.
The [controller guide](../guides/home-transfer-controller.md) owns setup,
private integration contracts, recovery limits, and reproducible checks.
Production control-session transport, operator reconciliation transport,
provider admission, and target activation
remain integration requirements under the
[channel home authority design](../design/channel-home-authority.md).

`@kontourai/station-contracts/cloud-move` owns the public preview shape.
`@kontourai/station-shared/cloud-move` owns bounded read-only setup inventory and
explicit provider selection. The AWS adapter in `packages/shared/src/cloud-aws-ec2.ts`
renders a deployment template; `packages/cli/src/commands/cloud.ts` is the thin
command caller. Preview is non-atomic and never grants transfer or execution
authority. The preview exports no credential stores, plugin journals, live
capabilities, workspace bytes or Session databases. Separate CLI workspace
commands use [workspace-package.ts](../../packages/shared/src/workspace-package.ts)
to pack, inspect, unpack and verify an encrypted Git workspace package. Its
receipt explicitly reports no execution-authority transfer or credential
enrollment; source/target quiescence remains the operator's prerequisite.
`cloud import-project` composes unpack/verification with the selected target's
Project creation API and retains an import if that HTTP mutation fails. These
operations do not activate a home transfer or resume an agent.
The [cloud-move design](../design/cloud-move.md)
owns the remaining transfer, enrollment, fencing, and UI sequence.

Actual filesystem and command tests live in
`packages/shared/src/__tests__/cloud-move.test.ts` and
`packages/cli/src/__tests__/cloud.test.ts`. Template generation and schema
validation do not establish AWS provisioning or application readiness.

## Browser test evidence

**Purpose.** `test:fixtures:check`, `test:journeys:profile` and
`test:mutation:smoke` provide different evidence: syntax-policy admission,
measured browser journeys and targeted known-bad changes. `gate:for` calls the
same `fixturePolicyCommands` owner. [The testing guide](../guides/testing.md#fixture-fidelity-and-test-effectiveness)
defines their intended use; none certifies every browser test by itself.

**Fixture boundary.** [Fixture policy](../../scripts/test-fixture-policy.mjs)
scans specified syntax and keeps an explicit baseline/strict-file set. It cannot
judge whether assertions reach the claimed behavior. Typed engine/conversation
factories describe backend responses; types do not make a fake backend real.
[fixture-audit.ts](../../tests/helpers/fixture-audit.ts) fails teardown for requests
sent through `rejectUnexpectedFixtureRequest` when a spec uses its extended
`test` fixture. It is not a global interceptor for every Playwright spec. Its
explicit focus-presence POST exception returns the real route's empty 204;
journeys about focus must model that route themselves.

**Profiling.** [Journey instrumentation](../../tests/helpers/journey-profile.ts)
uses Chromium CDP, React commit observation, storage and DOM counters without a
production endpoint. [The runner](../../scripts/run-journey-profiles.mjs)
selects declared journeys and binds results/raw profiles to the revision and
dirty state. Missing instrumentation fails instead of becoming zero-cost proof.
These are measurements of the named fixture journey and environment, not a
provider, native/device or general performance guarantee.

**Mutation.** [run-test-mutations.mjs](../../scripts/run-test-mutations.mjs)
requires a clean committed baseline, owns child processes through the shared
process helper, records exact replacement bytes, and verifies baseline,
intended caught failure and restored pass. Restoration refuses to overwrite
intervening edits. A nonzero exit from missing prerequisites or empty selection
is not a caught behavioral defect. The existing E2E runner still owns the app,
home and ports; these tools do not create a second app-lifecycle authority.

Policy known-bad/control tests, factory-to-caller checks, profile-schema tests
and mutation verdict/restoration tests exercise the named contracts. Preserve
the real user action and observable failure when changing a fixture; a static
PASS is not evidence that the UI worked.


## Monitoring history and Agent catalog reads

**Purpose.** These read paths avoid repeating work within a request while
preserving the distinction between diagnostic history, a current catalog and
execution authority.

[RuntimeEventLog.queryEvents](../../src-server/runtime/conversation/runtime-event-log.ts)
keeps timestamp bounds observed from each file's content, not its filename.
Unchanged files whose ranges cannot overlap a query are skipped. Device/inode,
size and nanosecond modification/change times invalidate that metadata after
an append or replacement; a file changed during a read is not memoized. Entries
for disappeared files are removed. There is no separate fixed entry-count cap
on this map, and it is not a persistent payload cache or a multi-file snapshot.
Missing files/history can yield no events; other filesystem failures propagate.
Malformed JSON or invalid timestamps are skipped, so a successful read does not
prove every stored line was included. The current query returns no skipped-line
completeness receipt.

The [Monitoring context](../../src-ui/src/contexts/MonitoringContext.tsx) owns
chronological reconciliation and the newest retained window. View filtering
preserves that order. Tool disclosures build details on expansion, and the
window's truncation flag lets the view explain that local search covers loaded
events. None of this proves that every telemetry instrument has a producer or
that an exporter delivered it; see [Monitoring](../guides/monitoring.md).

[AgentService.getAgentCatalog](../../src-server/services/agents/agent-service.ts)
combines registered and store-only Agents for both the Agent route and boot
aggregation. [ConfigLoader's catalog reader](../../src-server/domain/config-loader-agents.ts)
loads each definition once per request and carries its spec and metadata through
projection. Later requests read afresh; this catalog is not a process-wide
permission or availability cache. Invalid/unreadable per-Agent definitions are
logged and omitted, so absence from the returned list is not proof no definition
exists on disk. Runtime availability still has its own current-state owner.

Relevant history, catalog and Monitoring tests live beside these owners. Preserve
mtime/inode invalidation and per-request reads when optimizing; do not replace
storage failures with an authoritative empty catalog or treat loaded diagnostic
rows as a complete execution ledger.


## Transport and diagnostic leaf modules

These small owners keep transport and diagnostic dependencies from forming
cycles or growing a second lifecycle authority.

- **MCP transport.** [mcp-connection.ts](../../packages/shared/src/mcp-connection.ts)
  constructs transports and negotiates the MCP connection. The published
  [mcp.ts facade](../../packages/shared/src/mcp.ts) reexports that interface and
  supplies `MCPManager`. Local process custody imports the transport leaf,
  keeping the factory from importing its owner back through the facade. This
  dependency shape does not make an arbitrary MCP server trusted; connection
  admission and process custody remain separate responsibilities.
  [MCP UI policy construction](../../packages/shared/src/mcp-ui-csp.ts) is a
  separate browser-safe leaf. Its URL-scheme filtering is not full CSP
  source-expression validation or proof of browser network containment; the
  [MCP host design](../design/mcp-ui-host.md#resource-loading-and-policy) owns
  those limits and the separate frame boundary.
- **Foreground message dispatch.** [dispatchForeground](../../src-ui/src/lib/foregroundMessageDispatch.ts)
  maps target/model, staged attachments and the approval pick's compare-and-set
  basis into the SDK `sendExecutionMessage` call. Both direct chat and
  [queue drain](../../src-ui/src/hooks/orchestration/queueDrain.ts) load it.
  Queue completion does not import the React send hook and initialize the SSE
  graph again. A queued item does not bypass attachment readiness or approval
  basis checks.
- **Release variants.** [release-variants.mjs](../../scripts/lib/release-variants.mjs)
  supplies the shared variant definitions used by inventory and SBOM validation.
  Inventory and SBOM owners consume the leaf instead of importing each other.
  Declaring a variant is not evidence that its artifact was built or published.
- **Native diagnostics.** [Login-shell PATH observation](../../src-desktop/src/login_shell.rs)
  uses its own process group, nonblocking output, a five-second observation
  deadline and a 64 KiB output budget. Framing removes startup banners; missing,
  invalid or over-budget output yields no recovered PATH. Sidecar stderr handling
  in [lib.rs](../../src-desktop/src/lib.rs) retains at most 64 KiB and 16 lines,
  including the final decoded text, and stops reading on I/O error. These bounds
  are diagnostic behavior, not proof that a native launch succeeded.

Adjacent transport, dispatch and native unit tests cover these seams. Keep
public exports at the facade and implementation dependencies pointed toward
leaves; preserve owned-process cleanup and output bounds when moving code.


## BrowserSessionService

**Intent and Interface.** A Browser pane and authorized Agent act on the same
server-owned page. `browser-service.ts` composes acquisition, session registry,
profile-specific host resolution, local-target permissions and live-surface
binding. `BrowserHostResolver`/`BrowserHost` in `browser-host.ts` are the host
seam; only the local server-Chromium adapter is implemented. The selected
Station may be remote from its viewer, but a peer Browser host and desktop CEF
adapter are not implemented by naming them in the contract.

**Ownership and authorization.** `browser-session-registry.ts` owns session
records, browser generations and bounded action history. Profiles are keyed by
canonical Project ID and principal under `browser/profiles/`, with separate
cookie jars/processes for the operator and each Project admin.
`browser-access.ts` admits the operator or active Project admins/owners;
`actorOwnsSessionProfile` lets the operator see all profiles and restricts other
callers to their own. The personal-host gate is necessary, not authority by
itself. Internal credentials do not become human Pane authority.

**Composition and effects.** `runtime-routes.ts` mounts `/api/browser`,
`/api/browser-agent` and `/api/live-surfaces` on personal hosts.
`chromium-acquisition.ts` prefers installed browsers, otherwise requires
operator consent before fetching a pinned archive with size/SHA-256 and path
checks. `hosts/chromium-server-host.ts` launches through `spawnOwnedChild`, with
an allowlisted environment, a private CDP pipe and the profile's egress proxy.
`egress-policy.ts` refuses known Station listeners and ordinary DNS names that
resolve to private addresses. Operator profiles otherwise have broad reach;
Project-admin profiles need operator-registered local targets for non-public
addresses. `browser-service.ts` composes the listener inventory, including
device helpers; an unreadable sibling registry does not establish all-host
listener coverage. This boundary does not isolate arbitrary same-OS-user code.

**Callers and lifecycle.** `BrowserPreviewWorkspacePane.tsx` resolves bound
Project identity and migrates legacy state; `browser-pane/BrowserPane.tsx` and
`browserPaneApi.ts` own the human workflow. The built-in
`station-browser-mcp-server.ts` registers `station-control-browser-tools.ts`;
`browser-agent.ts` re-derives the verified caller, and
`browser-agent-authority.ts` mints the exact Project/profile grant consumed by
`BrowserAutomation`. Control operations capture a lease fence and check it
around asynchronous steps. JavaScript evaluation additionally needs the
Project's default-off permission; timeout/preemption does not undo an effect
already sent to Chromium. Closing a viewer only stops its capture subscription.
Host exit/restart produces `needs-reopen`, and old-generation live surfaces are
unregistered. Idle host shutdown runs after its last live target closes,
not merely when nobody watches.
`browser-live-surfaces.ts` also owns per-generation page tools: a JavaScript
dialog opened while a person holds the lease is held in
`ChromiumScreencastProducer` for that person (answered through
`POST /api/browser/sessions/:id/dialog`, never by an Agent, which is refused
`dialog-open` meanwhile); dialogs under an Agent or no holder are answered
automatically, and a held dialog is dismissed when the person's control
ends. `browser-console-log.ts` keeps a bounded in-memory console per browser
generation (agent-capable requests read it only under `browserEvaluate`), and
the registry's `captureScreenshot` serves the pane's screenshot, one capture
in flight per session.

**Evidence and limits.** Synthetic tests include `chromium-acquisition.test.ts`,
`browser-session-registry.test.ts`, `egress-policy.test.ts`,
`browser-live-surfaces.test.ts`, `browser-agent-authority.store.test.ts`,
`browser-pane-page.routes.test.ts`, `BrowserPane.test.tsx` and
`BrowserPane.pageTools.test.tsx`; real-host suites are separate
`.real.test.ts` files.
Synthetic PASS is not browser-version compatibility, hostile-page completeness,
Windows process-tree cleanup, mobile viewing or release evidence. Keep
`desktop-cef`/peer-host plans and the ADR's original research distinct from the
current [Browser guide](../guides/browser-workspace.md).

**Do not reintroduce:** profiles keyed only by slug or shared across principals;
caller identity supplied as tool arguments; a live claim from a saved Pane
reference; Chromium launched without its egress policy; or unlimited-history,
instant-cancellation or all-platform claims inferred from a fixture.

## Shared live surface

**Intent and Interface.** `packages/contracts/src/live-surface.ts` defines the
binary frame/state records and typed input. `producer.ts` defines the frame and
dispatch adapter; `registry.ts` registers a producer with its authorizer, hub
and read-only lease. A live surface is not a placement Surface or a second
Project authorization system. Browser and Device callers supply their own
view/input/control decisions; absent authority fails closed.

**State and ordering.** `surface-hub.ts` fans one producer out to viewers with
one pending frame per viewer, latest-frame replacement, acknowledgments and
adaptive delivery. Capture starts with the first viewer and stops at zero;
session lifetime remains with its Browser/Device owner. `control-lease.ts`
allows one controller: current-epoch human input can preempt an Agent, while
an Agent cannot preempt a live human. A person's `keep-alive` lease request
extends only their own current hold at the current epoch, never claims, and
is capped by `maxHumanHoldMs` from their last real input. Epoch identifies
controller succession;
the separate fence changes on release/expiry as well, so reclaiming cannot
resurrect old work. The registry serializes and fences input, cancels held
buttons/keys on handoff, and marks a timed-out dispatch wedged until it settles.
A producer may refuse an event for a reason the viewer can act on
(`LiveSurfaceInputRefusal`; today the Browser's `page-dialog-open`, while a
page dialog waits for its person), which reaches the viewer as that code
rather than `dispatch-failed`. It cannot cancel an arbitrary producer effect
already in flight.

**Real adapters and callers.** `browser-live-surfaces.ts` binds each live
browser generation to `ChromiumScreencastProducer` and its profile authorizer.
`DeviceSessionService` binds `DeviceLiveSurfaceProducer` to host-qualified
simulator/emulator sessions and device-share authorization. Device video and
input have separate liveness: iOS uses MJPEG; Android uses server-side H.264
decoding or a labelled PNG-poll fallback. A successful Device dispatch means
the hub socket accepted bytes, not that the application applied them. The
shared live-surface Agent grant path is wired for Browser tools; the Device
surface authorizer currently requires a human request.

`routes/live-surface.ts` serves one authenticated frame response per viewer and
separate input/lease requests. It rechecks stream authorization; a transient
busy authorizer is distinct from denial and retains a prior allow only within
a bounded grace. `useLiveSurface.ts` suspends hidden viewers, reconnects, and
coalesces input through one in-flight POST. `LiveSurfaceCanvas.tsx` is used by
the Browser pane, Device pane and float-over-chat. Shown-source tracking avoids
duplicating the same pane in its floater, but there is no single multiplexed
frame transport across all visible viewers. The input-slot requirement in
[ADR 0018](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md)
is an unqualified design constraint, not a measured production starvation
finding or a guaranteed latency bound.

**Evidence and limits.** `services/live-surface/__tests__/registry.test.ts`,
`control-lease.test.ts`, `surface-hub.test.ts`,
`routes/__tests__/live-surface.routes.test.ts`,
`runtime-routes-live-surface.test.ts` and `LiveSurfaceCanvas.test.tsx` exercise
synthetic producers, authorization, fencing and viewer lifecycle. Device
producer and session-route fixtures remain distinct from physical application
control. Do not infer input effect, device/app identity, relay throughput or
native platform parity from a decoded frame or an accepted socket write.

## MobileDeviceHost

**Purpose and boundary.** [LocalMobileDeviceHost](../../src-server/services/mobile-device/mobile-device-host.ts)
is Station's typed adapter to a simulator/emulator helper. It supports inventory,
a single PNG capture, boot, stream attachment and shutdown through fixed routes;
it does not forward arbitrary helper paths or shell commands. Physical phones
are excluded from this inventory. The [contract](../../packages/contracts/src/mobile-device.ts)
and [SDK](../../packages/sdk/src/mobile-device.ts) carry host-qualified device
identities and bounded responses.

**Composition and authority.** The personal runtime builds a
[device-host resolver](../../src-server/services/devices/device-host-resolver.ts)
for a configured local endpoint, an already-consented managed helper, or an
operator-managed SSH host. Hosted tenant execution does not mount this path.
Resolving a connection may start a consented helper; helper installation and
process ownership remain with the toolchain/host services. There is no peer
Station device transport merely because the resolver is extensible.

[Mobile-device routes](../../src-server/routes/mobile-device.ts) check current
request authority and device access before calling the helper, then recheck
currentness before publishing. The operator can use all devices; active admins
or owners use devices explicitly shared with their Project. Inventory is
filtered. Capture, start and open require device `drive` access. Power-off and
ending the session for everyone require operator authority. The outer pairing
scope gate separately requires terminal authority for mutation routes.

**Lifecycle and failure.** [DeviceSessionService](../../src-server/services/devices/device-session-service.ts)
owns one in-memory session/live surface per host/device. Starting a cold device
returns `starting` while boot continues; inventory carries progress or the last
start error. Opening a running simulator can attach its stream helper and
rechecks authority before surface registration. A viewer closing detaches only
that viewer. With no viewers the idle grace eventually ends the session;
ending a session leaves the device running, while power-off ends the session
and asks the helper to shut it down. Helper exit or an observed device stop
ends sessions; an unavailable inventory is not proof of a stop. A restart does
not restore live session/control authority from saved Pane data.

The helper adapter validates targets, checks fresh membership for capture,
refuses redirects, and bounds response size, image metadata and request/body
waits. Capture is a snapshot, not evidence of app identity or ongoing readiness.
The separate [Device producer](../../src-server/services/devices/device-live-surface-producer.ts)
feeds the shared live-surface path. The Tools drawer uses its own typed
[service](../../src-server/services/devices/device-tools.ts), device
access and control-conflict checks; it is not a generic extension of capture.

**Evidence.** `mobile-device-host.test.ts`, `mobile-device.routes.test.ts`,
`device-live-surface-producer.test.ts` and SDK tests exercise helper fixtures,
authorization and lifecycle. They do not establish a physical-device journey,
SSH host readiness, decoder compatibility or application effects. The
[operator guide](../guides/mobile-device-workspace.md) owns setup and controls.


## Project session directory

Before starting an engine, Station must resolve what a Project means on this computer. A portable repository reference and a local checkout are separate facts; this boundary checks their association before choosing the session directory.

`createProjectSessionDirectoryResolver` in
`src-server/services/projects/project-session-directory.ts` composes the
existing manifest and live resource resolver for new engine starts. Runtime
initialization installs it in OrchestrationService; recovery awaits it only
when the recorded session has no cwd. Bound resources return their local path;
only a directory-less organizational Project may default without a checkout.
Missing, drifted, ambiguous and unverifiable resources stop before engine
invocation. The caller retains path containment and owned-worktree admission.
Real Git/binding-to-engine tests live in `orchestration-service.test.ts`.
Resolution is an observation, not a filesystem lease or a compute grant.

## Workspace checkpoints

A checkpoint preserves repository files observed around a turn. Restoring one changes files; it does not undo the conversation, commands already run, or external services. Capture timing and restore authorization are separate boundaries.

**Purpose and interface.** Checkpoints retain file snapshots associated with a
Session's turn events. `TurnCheckpointCaptureCoordinator` queues `baseline`
and `settle` captures; `CheckpointIndexStore` records outcomes, and
`CheckpointRefStore` owns their Git objects/references. Capture includes tracked
and non-ignored untracked files. Missing directories, refused Git configuration,
capture failures, and pruned objects are distinct from an empty successful diff.

**Capture boundary.** The event subscriber queues work without waiting for it.
The per-thread queue orders captures with each other, not with engine effects.
The checkpoint mutation lock coordinates capture, retention, and restore; it
does not turn a phase label into proof of exact pre-turn or post-turn state.

**Restore boundary.** `CheckpointRestoreService.preview` binds a short-lived
preview to the caller, Session/turn/phase, checkpoint identity, and current
tree. It shows at most 200 paths and reports truncation. Confirmation rechecks
these facts, repository configuration, and caller authority, records a recovery
reference, materializes the target tree, verifies it, and persists a receipt.
Failure after filesystem work can leave an uncertain outcome; it is not an
automatic rollback of commands, conversation history, or external effects.

[Runtime composition](../../src-server/runtime/routes/runtime-routes.ts) wraps
restore in `OrchestrationService.runWorkspaceRestore`, which excludes admitted
turns for the same canonical Git working-tree root. It is not a filesystem
lease against arbitrary external editors/processes. The chat SDK selects only
`settle`; the CLI's separate authentication and preview gaps are tracked in
[#2734](https://github.com/kontourai/station/issues/2734).

**Follow the evidence.** Begin with the
[user journey](../user/workspace-checkpoints.md), then
[capture](../../src-server/services/checkpoints/turn-checkpoint-capture.ts),
[restore](../../src-server/services/checkpoints/checkpoint-restore.ts), and
[restore tests](../../src-server/services/checkpoints/__tests__/checkpoint-restore.test.ts).
These tests use isolated repositories; they do not prove a packaged app or a
restore in the user's working tree.

## Personal Work Board

**Purpose and interface.** Work Board stores typed references to existing work
plus a title, camera, pin layout/order, revision, and one undo snapshot. The
[store](../../src-server/services/spatial-board/spatial-board-store.ts) accepts
revision-checked mutations. The
[resolver](../../src-server/services/spatial-board/spatial-board-resolver.ts)
asks existing owners about pinned references; it cannot discover arbitrary work
or make a copied title, receipt, or status authoritative.

**Composition and limits.** Runtime mounts this store only outside hosted-tenant
execution and persists it in the Station home. Session/run resolution uses the
request's principal; the Board is not a separate grant to read its references.
The [Pane](../../src-ui/src/workspace-panes/SpatialBoardWorkspacePane.tsx)
uses the public SDK and only displays resolutions matching its loaded Board
revision. That check does not prove a newly loaded owner observation: queries
can retain cached data on return, and conflicting writes require manual refresh.
Cleanup checks Board revision and pinned identities but trusts the supplied
missing-reference selection rather than rereading each owner. It removes pins,
not underlying work. [#2736](https://github.com/kontourai/station/issues/2736)
records the proposed freshness/cleanup policy.

**Follow the evidence.** The [user guide](../user/work-board.md) describes
controls and recovery. [SDK mutations](../../packages/sdk/src/spatial-board.ts),
[routes](../../src-server/routes/spatial-board.ts), and
[owner resolution tests](../../src-server/services/spatial-board/__tests__/spatial-board-owner-resolver.test.ts)
show the request and storage boundaries. Mounted component tests do not prove
pointer geometry, contrast, or a physical touch-device journey.

## Native notification feed

**Purpose and interface.** `NotificationFeed` in
[`src-desktop/src/notification_feed.rs`](../../src-desktop/src/notification_feed.rs)
reads the server's decided notification-delivery feed outside the WebView, so a
window hidden in the tray does not suspend the desktop reader. It consumes
`GET /api/notifications/deliveries`; it does not decide quiet hours, mutes,
urgency or content redaction. A queued server delivery entry is not an OS display
receipt or evidence that a person saw the notification.

**Caller, state and authority.** Desktop startup in
[`lib.rs`](../../src-desktop/src/lib.rs) manages the state, registers the native
consumer/cursor/click commands, and starts its polling thread. Each read uses
the host-authorized active Station, that profile's credential, and the local
installation identity. Cursor and epoch persist per Station origin and echoed
surface. A cursor for another surface is not reused; a changed epoch marks a
restarted server. The
[WebView adapter](../../src-ui/src/platform/native/deliveryFeed.ts) asks whether
the native reader owns the feed before reading, and offers an old cursor once
for upgrade handoff. The native owner refuses a handoff that would rewind an
established cursor.

**Delivery and recovery limits.** The nominal poll interval is 20 seconds.
Focus-suppressed, refused and timed-out OS calls consume their entries; a call
that could not start leaves the cursor before that entry. The consumer saves
progress between calls, but a crash or failed save can replay work: this is not
exactly-once presentation. Bounded pending-call and late-result state keep a
stuck OS backend from opening unlimited threads. Linux can retract a notification
this process posted; the current macOS/Windows backends can suppress an unposted
alert but cannot close an already displayed one. Clicks focus Station and pass
only a validated in-app path to the main WebView.

**Evidence and change guidance.** Rust tests in the owner cover cursor/epoch and
surface changes, handoff, focus, malformed feeds, refused/timed-out/unstarted
calls, staleness, bounded stuck calls, late handles, and retraction. The
[WebView handoff tests](../../src-ui/src/__tests__/deliveryFeed.nativeConsumer.test.ts)
and [delivery tests](../../src-ui/src/__tests__/deliveryFeed.test.ts) cover its
consumer selection and cursor behavior. These are source and fixture owners;
packaged OS permission, visible delivery, background operation and clicks need
separate platform evidence. Do not revive the deleted `notification_watch.rs`
as a second reader: it would bypass the delivery router's envelope and privacy decisions.
See [desktop alerts](../guides/desktop-tray.md#desktop-alerts-while-the-window-is-hidden)
for the user-facing lifecycle.
