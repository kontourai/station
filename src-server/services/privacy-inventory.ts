import { USAGE_TELEMETRY_EVENTS } from './usage-telemetry-inventory.js';

type StoreDataType =
  | 'Audio Data'
  | 'Device ID'
  | 'Other User Content'
  | 'Other Usage Data'
  | 'Performance and Diagnostics';

export type PrivacyInventoryEntry = {
  id: string;
  storeDataType: StoreDataType;
  // Keep both values representable; declarations must not be fixed by the type.
  linkedToIdentity: boolean;
  usedForTracking: boolean;
  purpose: 'Analytics' | 'App Functionality';
  collection: string;
  destination: string;
  evidence: readonly string[];
  // Shared destination/consent entries may cover several events (archive#2486).
  usageTelemetry?: readonly { event: string; properties: readonly string[] }[];
};

/**
 * Declared store classifications and operational descriptions. Generated-byte
 * checks do not establish completeness or approve these classifications.
 */
const PRIVACY_INVENTORY: readonly PrivacyInventoryEntry[] = [
  {
    id: 'product-usage-telemetry',
    storeDataType: 'Other Usage Data',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'Analytics',
    collection:
      'Versioned event IDs and producer timestamps, inventory revision and installation hash, allowlisted app version/platform/architecture and optional full Git hash with provenance source, release channel and build-stamp dirty flag on every event; Station startup metadata, classified session-recovery outcomes (failure category, recovery decision, and result), and engine-turn terminal outcomes (engine family and completed/aborted/failed result). Delivery occurs only when STATION_TELEMETRY_ENDPOINT is configured, telemetry remains enabled, and the current inventory disclosure receipt exists.',
    destination:
      'The operator-configured STATION_TELEMETRY_ENDPOINT. A random per-install UUID is SHA-256 hashed before delivery; it is not account-derived.',
    evidence: [
      'src-server/services/usage-telemetry-inventory.ts',
      'src-server/services/usage-telemetry-service.ts',
    ],
    usageTelemetry: [
      { event: 'station_started', properties: ['version', 'platform', 'arch'] },
      {
        event: 'session_recovery',
        properties: ['failure_kind', 'decision', 'outcome'],
      },
      { event: 'engine_turn', properties: ['engine', 'outcome'] },
    ],
  },
  {
    id: 'otel-observability',
    storeDataType: 'Performance and Diagnostics',
    // archive#2484 replaced the hostname/user-derived custom ID with a random
    // installation hash. SDK resource detection is separate; review the full
    // exported payload before treating this declaration as substantiated.
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'Analytics',
    collection:
      "OpenTelemetry metrics and traces carry Station's random installation hash, operating-system type, and instrument attributes. The pinned SDK also enables environment, process, and host resource detection by default; effective attributes depend on its defaults and operator configuration. The custom installation hash does not establish that the complete payload is non-identifying. Station initializes export only when OTEL_EXPORTER_OTLP_ENDPOINT is configured.",
    destination: 'The operator-configured OTLP endpoint.',
    evidence: ['src-server/telemetry.ts', 'src-server/telemetry/metrics.ts'],
  },
  {
    id: 'knowledge-content',
    storeDataType: 'Other User Content',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'App Functionality',
    collection:
      'Documents selected for Knowledge are stored through the configured Station storage. The selected embedding provider receives document chunks and search queries. The selected vector provider receives chunk text, vectors, and document metadata. Local defaults do not prevent a configured remote provider from receiving that content.',
    destination:
      'Station storage and the configured embedding and vector providers. Embedding choices include Bedrock, OpenAI-compatible, and Ollama endpoints; extension-provided vector storage follows its configured destination.',
    evidence: [
      'src-server/services/knowledge/knowledge-documents.ts',
      'src-server/services/knowledge/knowledge-service.ts',
      'src-server/providers/lancedb-provider.ts',
      'src-server/providers/llm/bedrock-embedding-provider.ts',
      'src-server/providers/llm/openai-compat-provider.ts',
      'src-server/providers/llm/ollama-provider.ts',
    ],
  },
  {
    id: 'voice-audio',
    storeDataType: 'Audio Data',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'App Functionality',
    collection:
      'Microphone audio from an explicitly started voice session. The mobile client sends it over its authenticated Station voice WebSocket; Station forwards it to the configured speech-to-speech provider.',
    destination:
      "The user's Station and, for the built-in Nova Sonic provider, Amazon Bedrock. Any browser Web Speech provider handling is platform-defined and is NOT ESTABLISHED here.",
    evidence: [
      'src-ui/src/providers/voice/NovaVoiceSessionAdapter.ts',
      'src-server/voice/providers/nova-sonic.ts',
    ],
  },
  {
    id: 'agent-activity-push',
    storeDataType: 'Other User Content',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'App Functionality',
    collection:
      "An agent-activity card for a registered paired phone contains up to five sessions' titles, Project names, status, and activity counts. Titles can contain text from the user's request. The card is encrypted with the registration's payload key before delivery through Android FCM or iOS APNs Live Activities. The gateway and push provider can see routing tokens or channel IDs, registration identity, the Station push-key fingerprint, delivery timing and size, and transport control fields such as event and alert priority. They do not receive the card's session titles or Project names in plaintext. Delivery requires an active native-push registration; registration and notification settings determine which device receives it.",
    destination:
      'The configured push gateway (STATION_PUSH_GATEWAY_URL, default https://push.kontourai.io), then Google Firebase Cloud Messaging on Android or Apple Push Notification service on iOS. The gateway forwards sealed content and does not hold its decryption key.',
    evidence: [
      'src-server/services/notifications/agent-activity-publisher.ts',
      'src-server/services/notifications/agent-activity-card.ts',
      'src-server/services/notifications/agent-activity-seal.ts',
      'src-server/routes/operations/native-push-routes.ts',
      'deploy/push-gateway/src/gateway.ts',
      'deploy/push-gateway/src/apns-request.ts',
    ],
  },
  {
    id: 'station-notification-push',
    storeDataType: 'Other User Content',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'App Functionality',
    collection:
      'Notifications selected by Station delivery policy for registered paired phones. Bounded notification title/body and routing identities are encrypted with the registration payload key. Android can also receive a sealed Session reference and retraction. On iOS, an alert requires the separately registered APNs alert token; the gateway selects fixed public alert text from the supplied kind while carrying the notification text only inside the sealed payload. Content-hiding settings remove or replace title/body before encryption. The gateway and push provider still see routing metadata, urgency or alert kind, size and timing. A successful gateway send does not prove the phone displayed it.',
    destination:
      'The configured Kontour push gateway, then Google FCM for Android or Apple APNs for iOS. Without an iOS Notification Service Extension opening the sealed payload, iOS displays the fixed generic alert text.',
    evidence: [
      'src-server/services/notifications/delivery/fcm-alert-channel.ts',
      'src-server/services/notifications/delivery/apns-alert-channel.ts',
      'src-server/services/notifications/agent-activity-seal.ts',
      'src-server/routes/operations/native-push-routes.ts',
      'deploy/push-gateway/src/apns-request.ts',
    ],
  },
  {
    id: 'camera-qr-pairing',
    storeDataType: 'Other User Content',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'App Functionality',
    collection:
      'Camera frames are read only while the user opens the QR pairing scanner. The scanner decodes a pairing code in the WebView.',
    destination:
      "Local WebView processing; the decoded pairing value is used to pair with the user's Station. Camera imagery is not sent to a Station-operated third party by this scanner.",
    evidence: ['packages/connect/src/react/QRScanner.tsx'],
  },
] as const satisfies readonly PrivacyInventoryEntry[];

const DATA_SAFETY_PATH = 'docs/reference/play-data-safety.md';
const POLICY_PATH = 'docs/privacy-policy.md';
const IOS_PRIVACY_PATH = 'src-desktop/gen/apple/PrivacyInfo.xcprivacy';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

const APPLE_DATA_TYPE: Record<StoreDataType, string> = {
  'Audio Data': 'NSPrivacyCollectedDataTypeAudioData',
  'Device ID': 'NSPrivacyCollectedDataTypeDeviceID',
  'Other User Content': 'NSPrivacyCollectedDataTypeOtherUserContent',
  'Other Usage Data': 'NSPrivacyCollectedDataTypeOtherUsageData',
  'Performance and Diagnostics':
    'NSPrivacyCollectedDataTypeOtherDiagnosticData',
};
const APPLE_PURPOSE = {
  Analytics: 'NSPrivacyCollectedDataTypePurposeAnalytics',
  'App Functionality': 'NSPrivacyCollectedDataTypePurposeAppFunctionality',
} as const;

function inventoryRows(
  inventory: readonly PrivacyInventoryEntry[] = PRIVACY_INVENTORY,
): string {
  return inventory
    .map(
      (entry) =>
        `| \`${entry.id}\` | ${entry.storeDataType} | ${bool(entry.linkedToIdentity)} | ${bool(entry.usedForTracking)} | ${entry.purpose} | ${entry.collection} | ${entry.destination} | ${entry.evidence.map((path) => `\`${path}\``).join(', ')} |`,
    )
    .join('\n');
}

/**
 * Synthetic inventories exercise both flag values independently of today's
 * declarations; all-false production data once hid propagation bugs (archive#2484).
 */
export function renderPrivacyInfo(
  inventory: readonly PrivacyInventoryEntry[] = PRIVACY_INVENTORY,
): string {
  const appleDeclarations = new Map<string, PrivacyInventoryEntry>();
  for (const entry of inventory) {
    const key = `${entry.storeDataType}:${entry.purpose}`;
    const previous = appleDeclarations.get(key);
    appleDeclarations.set(key, {
      ...entry,
      linkedToIdentity:
        entry.linkedToIdentity || previous?.linkedToIdentity === true,
      usedForTracking:
        entry.usedForTracking || previous?.usedForTracking === true,
    });
  }
  const collected = [...appleDeclarations.values()]
    .map(
      (entry) =>
        `    <dict><key>NSPrivacyCollectedDataType</key><string>${APPLE_DATA_TYPE[entry.storeDataType]}</string><key>NSPrivacyCollectedDataTypeLinked</key><${entry.linkedToIdentity ? 'true' : 'false'}/><key>NSPrivacyCollectedDataTypeTracking</key><${entry.usedForTracking ? 'true' : 'false'}/><key>NSPrivacyCollectedDataTypePurposes</key><array><string>${APPLE_PURPOSE[entry.purpose]}</string></array></dict>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <${inventory.some((entry) => entry.usedForTracking) ? 'true' : 'false'}/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
${collected}
  </array>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict><key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>C617.1</string></array></dict>
  </array>
</dict>
</plist>
`;
}

export function renderPlayDataSafety(
  inventory: readonly PrivacyInventoryEntry[] = PRIVACY_INVENTORY,
): string {
  const anyLinked = inventory.some((entry) => entry.linkedToIdentity);
  const anyTracking = inventory.some((entry) => entry.usedForTracking);
  return `# Google Play Data Safety — Station\n\nGenerated from the declared inventory in \`src-server/services/privacy-inventory.ts\`, which also produces \`${IOS_PRIVACY_PATH}\`. These are draft answers derived from the declared inventory, not an approval or a complete data-flow assessment. Review the operational gaps in the [privacy policy](../privacy-policy.md#review-scope) before any submission. Do not edit this generated file by hand.\n\n## Declared answers\n\n- **Does the app collect or share any required user data types?** Yes, conditionally: configured telemetry/OTLP exporters, remote embedding providers, voice sessions, and agent-activity push to a registered phone can transmit the data listed below. Local-only behavior does not transmit data.\n- **Does this inventory declare any data as used for tracking?** ${anyTracking ? 'Yes.' : 'No.'}\n- **Does this inventory declare any data as linked to a user identity?** ${anyLinked ? 'Yes. Entries marked Linked below are declared linked; review their collection conditions and destinations.' : 'No.'}\n\n| Inventory entry | Play data type | Collected | Shared/destination | Declared purpose | Declared linkage | Declared tracking |\n| --- | --- | --- | --- | --- | --- | --- |\n${inventory.map((entry) => `| \`${entry.id}\` | ${entry.storeDataType} | Conditional as described | ${entry.destination} | ${entry.purpose} | ${entry.linkedToIdentity ? 'Yes' : 'No'} | ${entry.usedForTracking ? 'Yes' : 'No'} |`).join('\n')}\n\n## Inventory mapping and evidence\n\n| Inventory entry | Data type | Declared linkage | Declared tracking | Declared purpose | Collection and condition | Destination | Code evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n${inventoryRows(inventory)}\n\n## Owner action\n\nReview completeness, the shipped features, configured providers, and store classifications before approving these answers. Reconcile any approved changes with the inventory, generated artifacts, and public policy. Console submission is a separate owner action; generation does not perform it.\n`;
}

export function renderPrivacyPolicy(): string {
  return `# Station Privacy Policy\n\n*Generated working copy from Station's declared privacy inventory. Code and tests establish only the operational facts and checks described here. Store classifications, completeness, provider practices, and publication status require separate review.*\n\nStation can run on a user's own machine or an operator's server. Networked features send data according to their configuration, registration, and use. Product-usage telemetry uses a random installation identifier rather than an account identifier; this does not describe every field in OpenTelemetry exports. Desktop builds with an updater contact their configured release feed. Agent execution sends messages, supported attachments, tool results, and selected context to the chosen Model connection or engine. A local executable may use hosted inference or external tools; its service configuration and privacy practices still apply.\n\n## Data inventory\n\nThe linkage, tracking, and purpose columns below are declarations in the source inventory. They are not conclusions derived by the generator. The rows do not yet cover every data flow listed in the review scope.\n\n| Inventory entry | Data type | Declared linkage | Declared tracking | Declared purpose | Collection and condition | Destination | Code evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${inventoryRows()}\n\n## Review scope\n\nThe audit identified these additional flows and classification questions. They must be reconciled with the store declarations before those declarations can be treated as complete:\n\n- **OpenTelemetry resource attributes.** Station supplies a random installation hash and OS type, but the pinned SDK also detects environment, process, and host attributes. Its complete output depends on configuration and dependency defaults. Review the exported fields and destination; the custom identifier alone does not substantiate the inventory's linkage declaration. See [Monitoring](guides/monitoring.md).\n- **Optional local accounts and external sign-in.** When local accounts are enabled, Station stores account and session information for authentication and recovery. A configured OIDC provider is contacted for discovery at startup and exchanges login and identity data during sign-in. Returned account, token, and session records are retained in the operator's authentication store. Available request headers can supply session IP address and user-agent. Authentication is separate from Device and Project authorization. See [Deployment authentication](guides/deployment-authentication.md) and the local-account provider and runtime in the server's identity directory.\n- **Browser Web Push.** After permission and paired-device registration, Station retains the subscription endpoint and encryption keys with the device. Selected notifications are encrypted for that browser's push service; content hiding replaces title/body but retains routing and deep-link fields. The push infrastructure still receives destination and transport metadata, timing, and size. This is separate from native phone push and is disabled in the normal hosted-tenant wiring. See [Web Push](guides/web-push-notifications.md).\n\nThe audit inspected source and pinned dependencies, with synthetic tests for selected paths. It did not exercise real identity-provider login, resource export, browser/phone delivery, or store submission. A matching generated artifact proves consistency with this inventory, not a complete assessment of collection or a legal classification.\n\n## Your choices\n\n- Product-usage telemetry does not send until an endpoint is configured and the current disclosure receipt is acknowledged; it can be disabled.\n- Station initializes OTel export only when an OTLP endpoint is configured. Review dependency resource detection and instrument attributes as well as Station's explicit fields.\n- Knowledge delivery follows the configured storage, embedding, and vector providers; review remote provider settings before adding content.\n- The QR pairing scanner reads camera frames while it is open. The selected voice adapter controls microphone capture and its transport; these statements do not certify every possible extension's use of a device.\n- Native push requires device registration and current delivery eligibility. Removing registration prevents future selection; it does not recall a message already sent or displayed.\n- Browser push has its own subscription and unsubscribe controls. Turning off its feature setting hides the controls; it does not itself unsubscribe an existing browser registration.\n\n## Contact and public URL\n\n- Public policy URL: https://kontourai.io/privacy/station/\n- Contact: hello@kontourai.io\n\nPublic text should preserve the approved facts while omitting contributor-oriented source paths. A fingerprint mismatch identifies differing versions; review both the inventory and the approved public text before changing either. Regeneration does not publish the page or update a store listing.\n`;
}

export const PRIVACY_RENDERED_ARTIFACTS = {
  [IOS_PRIVACY_PATH]: renderPrivacyInfo(),
  [DATA_SAFETY_PATH]: renderPlayDataSafety(),
  [POLICY_PATH]: renderPrivacyPolicy(),
} as const;

/** Makes generated declarations fail closed when an artifact is hand-edited. */
export function assertPrivacyRenderedArtifacts(
  read: (path: keyof typeof PRIVACY_RENDERED_ARTIFACTS) => string,
): void {
  for (const [path, expected] of Object.entries(PRIVACY_RENDERED_ARTIFACTS)) {
    if (read(path as keyof typeof PRIVACY_RENDERED_ARTIFACTS) !== expected)
      throw new Error(
        `Privacy inventory drift: rendered artifact "${path}" does not match the inventory.`,
      );
  }
}

/** Prevent a new telemetry event/property from bypassing the store inventory. */
export function assertPrivacyInventoryCoversUsageTelemetry(
  events: Record<
    string,
    { properties: Record<string, unknown> }
  > = USAGE_TELEMETRY_EVENTS,
): void {
  const declared = new Map(
    PRIVACY_INVENTORY.flatMap((entry) =>
      (entry.usageTelemetry ?? []).map(
        (declaration) => [declaration.event, declaration.properties] as const,
      ),
    ),
  );
  for (const [event, definition] of Object.entries(events)) {
    const properties = declared.get(event);
    if (!properties)
      throw new Error(
        `Privacy inventory drift: telemetry event "${event}" is not declared.`,
      );
    for (const property of Object.keys(definition.properties)) {
      if (!properties.includes(property))
        throw new Error(
          `Privacy inventory drift: telemetry property "${event}.${property}" is not declared.`,
        );
    }
    for (const property of properties) {
      if (!(property in definition.properties))
        throw new Error(
          `Privacy inventory drift: declared telemetry property "${event}.${property}" is absent from code.`,
        );
    }
  }
}
