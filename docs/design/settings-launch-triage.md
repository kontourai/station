# Settings launch triage

Status: source-based decision inventory, 2026-10-19. Covers all **76 catalog
entries** in this branch (73 existing entries plus three developer opt-ins),
and additional nested controls below. Baseline:
`ac9a23234b1e5ec036b3c240b1ed910de24db19c`. This is a Settings review, not an
app-wide launch certification. “Keep” means the option has a clear purpose;
it does not assert that every platform, failure path or provider was tested.

## Agreed launch direction

Unproven features have individual, default-off developer opt-ins. A Developer
tools switch reveals choices and never enables them all. Promote a feature only
after an owner can show a useful complete journey, working failure/recovery
paths, readable desktop/mobile UI, accessible keyboard/touch interactions, and
appropriate platform/provider evidence. A unit test, registry entry or polished
empty state is insufficient. This is review policy, not a new automatic CI gate.

Implemented here: Flow delivery, Veritas readiness and Trust UI opt-ins;
normal Coding stays available. Server APIs, authorization, stored evidence and
backend configuration are unchanged. Client gates are not security controls.
Turning previews off may withdraw panes from a saved arrangement.

## Decisions to make before launch

1. **Approval guardian, workspace checkpoints, voice pill and automatic browser
   floating:** gate candidates. They automate or interrupt user work and need
   complete workflow evidence before normal exposure. Checkpoints and guardian
   already have off defaults; that is not evidence of hardened recovery.
2. **Telemetry:** do not present unavailable Lite sending as a working delivery
   choice. Keep Off and a truthful effective state. Separate consent from
   operator receiver/collector configuration and diagnostic counters.
3. **Defaults:** scope model, token, prompt and region controls to engines that
   consume them. The max-turns copy is qualified in this change; runtime limits
   are unchanged. Strands does not consume that VoltAgent step cap.
4. **Host/device infrastructure:** keep ordinary Settings about user choices;
   move helper hosts, helper URL, custom registries and collector configuration
   into developer/operator setup. Host diagnostics now load only on request.
5. **Voice and push:** show usable capabilities and actual connection/delivery
   state. No live voice provider or physical-device delivery is qualified here.
6. **No unsupported “dead setting” claim:** Device helper URL has a real
   restart-bound consumer in `runtime-routes.ts` → `DeviceToolchainService`.
   Its weak everyday value is a placement problem, not proof of inert code.

## Account administration refusal

The account routes require `access:manage`; the handler additionally checks a
bound operator credential or local home possession. A Project/account role alone
does not add that scope to a paired connection. Device-requested grants do not
include it by default. The UI now explains the connection-level refusal rather
than showing raw `insufficient_scope`; it does not widen permissions.

Owners: [route scope](../../src-server/security/pairing-route-scopes.ts),
[requested grant ceilings](../../packages/contracts/src/environment-security.ts),
[HTTP scope enforcement](../../src-server/runtime/bootstrap/runtime-http.ts),
[bound operator check](../../src-server/runtime/routes/runtime-routes.ts),
[account handler](../../src-server/routes/system/local-account-administration-routes.ts).
Brian’s actual phone grant was not inspected: this explains the source-supported
failure mechanism, not a confirmed diagnosis of that exact credential.

## Catalog inventory

Dispositions other than “implemented” are recommendations awaiting a product
decision. Source links identify the behavior/presentation owner; they are not
proof of complete qualification. Names and IDs remain stable unless explicitly
changed. No inventory item below is silently marked launch-hardened.

| Control (`id`) | Disposition | Value, limitation or next decision | Owner |
| --- | --- | --- | --- |
| Import previous preferences (`account-preference-sync`) | Keep | Explicit one-time import; does not silently migrate permissions. | [source](../../src-ui/src/contexts/AccountPreferencesProvider.tsx) |
| New Codex chats (`personal-codex-approval`) | Keep | Real engine-specific default; keep effective permissions and precedence visible. | [source](../../src-ui/src/views/settings/AccountPreferencesSection.tsx) |
| New Claude chats (`personal-claude-approval`) | Keep | Same personal-default contract; must never masquerade as the started session’s posture. | [source](../../src-ui/src/views/settings/AccountPreferencesSection.tsx) |
| New Muse chats (`personal-muse-approval`) | Keep | Retain the engine-specific choice; provider availability is separate. | [source](../../src-ui/src/views/settings/AccountPreferencesSection.tsx) |
| Desktop app updates (`desktop-app-updates`) | Keep | Shell update workflow; validate signed update/restart and unsupported-platform states. | [source](../../src-ui/src/views/settings/SystemSection.tsx) |
| Connected Station server (`core-app-updates`) | Simplify | Remote server update is distinct from this client’s app update; show target and restart consequences. | [source](../../src-ui/src/views/settings/SystemSection.tsx) |
| Deployed Build (`deployed-build`) | Move | Troubleshooting information, not a preference; keep in About/diagnostics. | [source](../../src-ui/src/views/settings/SystemSection.tsx) |
| Log Level (`log-level`) | Move | Operator troubleshooting; avoid implying logging must be enabled for normal use. | [source](../../src-ui/src/views/settings/SystemSection.tsx) |
| Settings Export & Import (`backup-restore`) | Keep | Recovery value; distinguish Station config from device preferences and credentials. | [source](../../src-ui/src/views/settings/utils.ts) |
| Reset Station settings (`reset-defaults`) | Keep | Destructive configuration action needs its existing preview and confirmation. | [source](../../src-ui/src/views/settings/station-reset.ts) |
| Restore device defaults (`reset-device-defaults`) | Keep | Resets the declared preference subset, not all local state; preserve account exclusions. | [source](../../src-ui/src/views/settings/station-reset.ts) |
| Feature previews (`feature-previews`) | Simplify | Server-wide previews and device UI previews are separate stores; explain scope, avoid two competing catalogs. | [source](../../src-ui/src/views/settings/FeaturePreviewsSection.tsx) |
| Enable developer tools (`enable-developer-tools`) | Keep | Reveals navigation and preview choices; turning it on enables no preview by itself. | [source](../../src-ui/src/views/SettingsView.tsx) |
| Flow delivery preview (`experimental-flow`) | Gate (implemented) | Independent device opt-in; no live complete delivery/value qualification claimed. | [source](../../src-ui/src/hooks/useDeveloperFeatures.ts) |
| Veritas readiness preview (`experimental-readiness`) | Gate (implemented) | Independent device opt-in; readiness output is not merge approval. | [source](../../src-ui/src/hooks/useDeveloperFeatures.ts) |
| Trust preview (`experimental-trust`) | Gate (implemented) | Independent device opt-in; evidence display is not an independent trust verdict. | [source](../../src-ui/src/hooks/useDeveloperFeatures.ts) |
| Shared answers (`shared-answers`) | Keep | Manage existing public answer links; revocation and target visibility are the value. | [source](../../src-ui/src/views/settings/AnswerSharesSection.tsx) |
| Plugin visibility (`plugin-visibility`) | Keep | Installed-plugin discoverability control, separate from permissions; make the distinction clear. | [source](../../src-ui/src/views/settings/PluginVisibilitySection.tsx) |
| Device hosts (`device-hosts`) | Move / qualify | SSH device-helper hosts are developer infrastructure; move under Developer tools after connect/capture/revoke qualification. | [source](../../src-ui/src/views/settings/DeviceHostsPanel.tsx) |
| People (`people`) | Simplify | Account/group access belongs with collaboration and access; do not confuse it with a connection grant. | [source](../../src-ui/src/views/settings/PeopleSection.tsx) |
| Host diagnostics (`host-runtime`) | Move (implemented) | On-demand Host diagnostics; no duplicated timeout framed as a required installation repair. | [source](../../src-ui/src/views/settings/EnvironmentStatus.tsx) |
| Terminal shell (`terminal-shell`) | Keep | Real terminal launch setting; keep host scope and unsupported-shell feedback. | [source](../../src-server/services/terminal/terminal-shells.ts) |
| MCP UI host (`mcp-ui-host`) | Simplify | Rename toward “Interactive tool interfaces”; actual frame capability, not a generic host status. | [source](../../src-ui/src/components/mcp-ui/MCPToolUIFrame.tsx) |
| Surface trust from Veritas evidence (`surface-trust`) | Gate (implemented) | Hidden with Trust preview off; backend evidence derivation remains unchanged. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Conversations outside projects (`attached-sessions-outside-projects`) | Keep / qualify | Privacy-sensitive import: disabling stops new imports, not stored history. New-home default is off; do not infer all legacy homes are off. | [source](../../src-server/runtime/bootstrap/runtime-initialize.ts) |
| Device helper URL (`device-helper-url`) | Move | Real restart-bound helper-service address; not dead configuration. Developer infrastructure. | [source](../../src-server/runtime/routes/runtime-routes.ts) |
| Registry URL (`registry-url`) | Move | Startup-only install source override; most users need no override. Developer/operator configuration. | [source](../../src-server/runtime/bootstrap/runtime-initialize.ts) |
| Disable default skill registries (`default-skill-registries`) | Simplify | Negative toggle is hard to parse; prefer “Use built-in skill catalogs” while preserving stored-key compatibility. | [source](../../src-server/runtime/bootstrap/runtime-startup.ts) |
| Layout sources (`distribution-profile`) | Move | Chooses layout sources at startup; not a release/distribution channel. Developer/operator configuration. | [source](../../src-server/runtime/routes/runtime-routes.ts) |
| Usage telemetry (`usage-telemetry`) | Simplify before launch | Lite can be selected although sending is unavailable; Kontour Full is unavailable. Keep Off and accurately distinguish stored intent from delivery. | [source](../../src-ui/src/views/settings/TelemetryTierSettings.tsx) |
| Telemetry destination (`telemetry-destination`) | Simplify | Keep effective destination next to consent; no extra empty destination card. | [source](../../src-ui/src/views/settings/TelemetryDelivery.tsx) |
| Product delivery (`product-telemetry-delivery`) | Move | Delivery diagnostics are useful to operators; a configured receiver is not an acknowledgement of receipt. | [source](../../src-ui/src/views/settings/TelemetryDelivery.tsx) |
| Product receiver address (`productTelemetryEndpoint`) | Move | Advanced operator receiver setup, not an ordinary privacy preference. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Product receiver key reference (`productTelemetryKeyRef`) | Move | Protected credential reference for operator receiver; do not present as a raw-secret entry. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Metrics and traces (`otel-delivery`) | Move | Operational metrics/traces diagnostics have separate consent/configuration semantics. | [source](../../src-ui/src/views/settings/TelemetryDelivery.tsx) |
| Collector address (`otelTelemetryEndpoint`) | Move | Operator OTLP collector setup, restart-bound; hide until configuring a collector. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Collector key reference (`otelTelemetryKeyRef`) | Move | Protected collector credential reference; show with collector setup. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Diagnostics bundle (`diagnostics-bundle`) | Keep | Clear support task; compact action. Download contents/redaction need their own security evidence. | [source](../../src-ui/src/views/SettingsView.tsx) |
| Approval guardian (`approval-guardian`) | Gate candidate | Off-by-default extra-model approval decisions deserve explicit developer qualification; not equivalent to human approval. | [source](../../src-server/services/approvals/approval-guardian.ts) |
| Default approval mode (`default-approval-mode`) | Keep | Security-critical default: state unattended-run consequences; never hide effective permissions behind a preview. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Default model (`default-model`) | Simplify | Fallback after more specific Agent/Project/connection choices; scope to supported managed turns. | [source](../../src-server/runtime/frameworks/framework-model-factory.ts) |
| Default Region (`default-region`) | Move | AWS/provider-specific setup; only useful for matching providers. | [source](../../src-server/providers/llm/bedrock-region.ts) |
| Default Agent Instructions (`default-agent-instructions`) | Simplify | Managed-agent fallback instructions; do not imply override of every native engine’s own instructions. | [source](../../src-server/runtime/bootstrap/runtime-initialize.ts) |
| Template Variables (`template-variables`) | Move | Advanced prompt templating; show with instructions rather than a freestanding preference. | [source](../../src-server/domain/config-loader.ts) |
| Built-in agent engine (`builtin-agent-engine`) | Simplify | Connection choice for built-in agents; consolidate with model/engine setup and explain fallback. | [source](../../src-server/runtime/bootstrap/runtime-initialize.ts) |
| Default max turns (`default-max-turns`) | Simplify (copy fixed) | VoltAgent fallback step cap, overridden by Agent limits; not applied by Strands or native engines. | [source](../../src-server/runtime/frameworks/voltagent-adapter.ts) |
| Default max output tokens (`default-max-output-tokens`) | Simplify | Model-constructor option for managed adapters; no universal native-engine guarantee. Show supported scope. | [source](../../src-server/runtime/frameworks/framework-model-factory.ts) |
| New chat workspace (`default-workspace-isolation`) | Keep / qualify | Shared checkout versus owned Git worktree has clear value; test creation, cleanup, conflict, resume and non-Git refusal. | [source](../../src-ui/src/views/settings/StationConfigSection.tsx) |
| Workspace checkpoints (`workspace-checkpoints`) | Gate candidate | Already off by default; capture is not full restore/recovery proof. Require restore/prune/disk-failure qualification. | [source](../../src-server/services/checkpoints/turn-checkpoint-capture.ts) |
| Resume after usage limits (`usage-limit-auto-resume`) | Keep / qualify | Claude Code/Codex resume can spend quota unattended; require cancellation, restart, expiry and retry-bound evidence. | [source](../../src-server/services/orchestration/session-recovery-coordinator.ts) |
| Review guides (`review-guides`) | Keep / qualify | Already default off; head-bound PR tours are a distinct value, not a review verdict. Require provider-backed generation/value proof. | [source](../../src-server/services/pull-requests/pull-request-review-guide.ts) |
| Review guide model (`review-guide-model`) | Simplify | Show only while review guides are enabled; empty means the structure model. | [source](../../src-server/runtime/routes/runtime-routes.ts) |
| Review guide instructions (`review-guide-instructions`) | Simplify | Show with enabled review guides; preferences do not override coverage/excerpt validation. | [source](../../src-server/runtime/routes/runtime-routes.ts) |
| Chat font size (`chat-font-size`) | Keep | Direct readability preference; distinguish from shared Station fallback. | [source](../../src-ui/src/components/chat-dock/ChatDock.tsx) |
| Default chat font size (`default-chat-font-size`) | Move | Shared fallback for accounts without their own choice; avoid two competing font controls in one ordinary flow. | [source](../../src-ui/src/contexts/ConfigContext.tsx) |
| Answer delivery (`smooth-answer-reveal`) | Keep | Personal rendering choice; preserve partial/error/final transcript semantics. | [source](../../src-ui/src/components/chat-dock/ChatDock.tsx) |
| Show reasoning (`chat-show-reasoning`) | Keep | Display preference, not a promise every engine exposes reasoning. | [source](../../src-ui/src/hooks/useChatDockState.ts) |
| Show tool details (`chat-show-tool-details`) | Keep | Useful display preference; collapsed tools must retain failures and approval requests. | [source](../../src-ui/src/hooks/useChatDockState.ts) |
| Auto-hide chat dock (`chat-dock-auto-hide`) | Keep | Clear layout preference; verify focus and unread/attention behavior. | [source](../../src-ui/src/hooks/useChatDockState.ts) |
| Automatically show agent browser sessions (`chat-auto-float-browser`) | Gate candidate | Automatic focus/layout changes need real narrow-screen and reader-intent evidence. | [source](../../src-ui/src/hooks/useFeatureSettings.ts) |
| Diff view style (`diff-style`) | Keep | Unified/split is concrete user value; responsive fallback must stay readable. | [source](../../src-ui/src/components/coding-layout/DiffPanel.tsx) |
| Diff line wrap (`diff-wrap`) | Keep | Concrete long-line readability choice. | [source](../../src-ui/src/components/coding-layout/DiffPanel.tsx) |
| Ask before deleting a conversation (`confirm-conversation-delete`) | Keep | User-controlled safeguard for one conversation; does not disable all destructive confirmations. | [source](../../src-ui/src/components/chat/ConversationHistory.tsx) |
| Theme (`theme`) | Keep | Basic appearance preference; both themes need actual visual checks. | [source](../../src-ui/src/main.tsx) |
| Haptic feedback (`haptic-feedback`) | Keep | Native mobile capability; omit on unsupported browser/desktop surfaces. | [source](../../src-ui/src/platform/native/haptics.ts) |
| Accent color (`accent-color`) | Keep | Basic appearance preference; contrast and keyboard focus still need verification. | [source](../../src-ui/src/main.tsx) |
| Keyboard shortcuts (`keyboard-shortcuts`) | Keep | Rebinding has clear value; conflict, reset and platform reserved keys matter. | [source](../../src-ui/src/views/settings/KeyboardShortcutsSection.tsx) |
| Push notifications (`push-notifications`) | Keep / qualify | Permission, subscription and actual delivery differ across browser/APNs/FCM; do not equate toggle-on with received alerts. | [source](../../src-ui/src/App.tsx) |
| Speech-to-text (microphone input) (`speech-to-text`) | Simplify / qualify | Only offer providers usable on this platform; no live provider transcription verified here. | [source](../../src-ui/src/contexts/VoiceProviderContext.tsx) |
| Text-to-speech service (`text-to-speech`) | Simplify / qualify | Provider setup is distinct from readback preference; capability-aware empty states. | [source](../../src-ui/src/contexts/VoiceProviderContext.tsx) |
| Message context (`message-context`) | Move | Temporary message/provider context belongs with compose-time voice setup, not persisted app settings. | [source](../../src-ui/src/views/SettingsView.tsx) |
| Voice pill (speech-to-speech) (`voice-pill`) | Gate candidate | Full speech-to-speech flow lacks live-provider evidence in this review; require latency, interruption and permission-denial qualification. | [source](../../src-ui/src/App.tsx) |
| Read replies aloud (`tts-readback`) | Simplify / qualify | Only useful with a usable TTS provider; require stop/interruption/reconnect behavior. | [source](../../src-ui/src/hooks/useFeatureSettings.ts) |
| Device pairing (`mobile-pairing`) | Keep | Core device connection and revocation journey; never mistake a paired grant for operator authority. | [source](../../src-ui/src/views/settings/PairingSection.tsx) |
| Open last Station on launch (`open-last-station`) | Keep | Concrete mobile startup choice; unavailable/revoked last Station must be recoverable. | [source](../../src-ui/src/platform/PlatformProfileContext.tsx) |
| My knowledge store (`personal-knowledge-store`) | Keep / qualify | Concrete root selection; path validation is not search/retrieval value proof for every adapter. | [source](../../src-ui/src/views/settings/KnowledgeStoreSection.tsx) |

## Nested controls outside the catalog count

| Surface | Disposition and qualification needed | Owner |
| --- | --- | --- |
| Account enable/disable, revoke sessions, recovery links | Keep operator-only; confirm destructive actions, clear recovery URLs on authority changes, explain refused connections. | [LocalAccountsSection](../../src-ui/src/views/settings/LocalAccountsSection.tsx) |
| Agent notification level | Keep; “Off” means inbox-only, not lost events. | [NotificationDeliverySettings](../../src-ui/src/views/settings/NotificationDeliverySettings.tsx) |
| Quiet hours, start/end, urgent bypass, time zone | Keep; verify cross-midnight windows, zone changes and urgent exceptions at server dispatch. | [NotificationDeliverySettings](../../src-ui/src/views/settings/NotificationDeliverySettings.tsx) |
| Per-device urgency threshold | Keep with device identity/revocation; saving a threshold is not delivery proof. | [NotificationDeliverySettings](../../src-ui/src/views/settings/NotificationDeliverySettings.tsx) |
| Notification sound categories and sound preview | Keep compact; verify mute, autoplay refusal and native/browser differences. | [NotificationSoundSettings](../../src-ui/src/views/settings/NotificationSoundSettings.tsx) |
| Server preview: fleet consumer probes | Already explicit preview; consumes a completion on another Station. Move alongside developer experiments; prove routing benefit, cancellation and cost before promotion. | [FeaturePreviewsSection](../../src-ui/src/views/settings/FeaturePreviewsSection.tsx) |
| Model picker pinned/hidden choices | Keep contextual in the model picker; account-scoped choice does not grant model access. | [device store](../../src-ui/src/lib/device-settings-store.ts) |
| Per-project model/approval overrides | Keep contextual to Project setup; distinguish effective inheritance and actual session posture. | [inheritance dialog](../../src-ui/src/views/settings/SettingInheritanceLayers.tsx) |

## Verification boundaries

The focused Settings, pane-discovery, Coding-renderer, account-refusal and Flow
console tests exercise UI behavior with controlled SDK answers. They do not
prove live model execution, complete Flow delivery, independent Veritas/Trust
value, push delivery or native shell behavior. Browser screenshots establish
rendered geometry only at the recorded viewport/theme. Emulator flows remain
the allowed mobile verification scope; no physical-phone or billable provider
check was requested for this review.

The source-reference inventory was a discovery aid. Each higher-risk finding
above was checked at its owning caller; an unused-looking key alone was never
classified as dead. Broader application surfaces outside Settings remain
unreviewed and need their own inventory before a launch-wide claim.
