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
  // Deliberately `boolean`, not the literal `false`. Typing these as `false`
  // made an honest declaration unrepresentable — the schema could only express
  // "nothing is linked, nothing tracks", which is a conclusion, not a field.
  linkedToIdentity: boolean;
  usedForTracking: boolean;
  purpose: 'Analytics' | 'App Functionality';
  collection: string;
  destination: string;
  evidence: readonly string[];
  // One inventory entry can cover several telemetry events — they share a
  // destination, a purpose and a consent gate, so they are one disclosure to
  // a reader. It was a single event until archive#2486 added two more and the
  // coverage assertion caught the omission.
  usageTelemetry?: readonly { event: string; properties: readonly string[] }[];
};

/**
 * The sole privacy declaration for store disclosures, generated artifacts, and
 * policy text. Conditional entries are still declared because configuration
 * can enable their network delivery in a shipped build.
 */
export const PRIVACY_INVENTORY: readonly PrivacyInventoryEntry[] = [
  {
    id: 'product-usage-telemetry',
    storeDataType: 'Other Usage Data',
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'Analytics',
    collection:
      'Station startup metadata (app version, operating-system platform, and CPU architecture), classified session-recovery outcomes (failure category, recovery decision, and result), and engine-turn terminal outcomes (engine family and completed/aborted result). Delivery occurs only when STATION_TELEMETRY_ENDPOINT is configured, telemetry remains enabled, and the current inventory disclosure receipt exists.',
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
    // archive#2484 landed: the identifier is now the SHA-256 of a random UUID
    // created once per install under STATION_HOME, independent of hostname and
    // username. It is a stable PSEUDONYMOUS installation id — consistent within
    // whatever collector the operator points it at, so per-install grouping
    // still works — and it is not linked to a person, which is why this is
    // false again. It was `true` while the value was sha256(hostname:username)
    // truncated to 48 bits, which anyone with a candidate list could match.
    linkedToIdentity: false,
    usedForTracking: false,
    purpose: 'Analytics',
    collection:
      'OpenTelemetry metrics and traces, carrying a stable per-install identifier (the SHA-256 of a random UUID stored under STATION_HOME, not derived from the machine or any account), operating-system type, and instrument attributes. Export occurs only when OTEL_EXPORTER_OTLP_ENDPOINT is configured.',
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
      'Documents and text selected for Knowledge are stored in the Station home and indexed locally. If the user configures a remote embedding provider, document chunks and search queries are submitted to that provider to produce embeddings.',
    destination:
      'Local Station storage by default; otherwise the user-configured Bedrock, OpenAI-compatible, or Ollama embedding endpoint.',
    evidence: [
      'src-server/services/knowledge/knowledge-documents.ts',
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

export const APPLE_DATA_TYPE: Record<StoreDataType, string> = {
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

function inventoryRows(): string {
  return PRIVACY_INVENTORY.map(
    (entry) =>
      `| \`${entry.id}\` | ${entry.storeDataType} | ${bool(entry.linkedToIdentity)} | ${bool(entry.usedForTracking)} | ${entry.purpose} | ${entry.collection} | ${entry.destination} | ${entry.evidence.map((path) => `\`${path}\``).join(', ')} |`,
  ).join('\n');
}

/**
 * `inventory` is a parameter so the linkage/tracking propagation can be proven
 * for BOTH values regardless of what the real inventory happens to contain
 * today. It was previously provable only while some real entry was linked,
 * which made the guard evaporate the moment archive#2484 made them all false —
 * exactly when a silent regression would stop being visible.
 */
export function renderPrivacyInfo(
  inventory: readonly PrivacyInventoryEntry[] = PRIVACY_INVENTORY,
): string {
  const appleDeclarations = new Map(
    inventory.map((entry) => [
      `${entry.storeDataType}:${entry.purpose}`,
      entry,
    ]),
  );
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
  <false/>
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
  return `# Google Play Data Safety — Station\n\nGenerated from \`${IOS_PRIVACY_PATH}\`'s source inventory in \`src-server/services/privacy-inventory.ts\`. Transcribe these answers into Play Console; do not edit this file by hand.\n\n## Answers\n\n- **Does the app collect or share any required user data types?** Yes, conditionally: configured telemetry/OTLP exporters, remote embedding providers, and voice sessions can transmit the data listed below. Local-only behavior does not transmit data.\n- **Is any data used for tracking?** No.\n- **Is any data linked to a user identity?** ${anyLinked ? 'Yes. Entries marked Linked below contain identity-derived data; see their collection conditions and destinations.' : 'No.'}\n\n| Inventory entry | Play data type | Collected | Shared/destination | Purpose | Linked | Tracking |\n| --- | --- | --- | --- | --- | --- | --- |\n${inventory.map((entry) => `| \`${entry.id}\` | ${entry.storeDataType} | Conditional as described | ${entry.destination} | ${entry.purpose} | ${entry.linkedToIdentity ? 'Yes' : 'No'} | ${entry.usedForTracking ? 'Yes' : 'No'} |`).join('\n')}\n\n## Inventory mapping and evidence\n\n| Inventory entry | Data type | Linked to identity | Used for tracking | Purpose | Collection and condition | Destination | Code evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n${inventoryRows()}\n\n## Owner action\n\nSubmit these answers in Play Console after reviewing the current configured providers. The console submission itself is owner-only.\n`;
}

export function renderPrivacyPolicy(): string {
  return `# Station Privacy Policy\n\n*This policy is generated from Station's privacy inventory and published at https://kontourai.io/privacy/station/ , which is the URL the App Store and Play listings point at. If this file and that page disagree, this inventory is right and the page is stale.*\n\nStation is self-hosted. It does not use data for cross-app or cross-site tracking and does not derive its telemetry identifiers from an account. Station sends data away from the device only when a user or operator configures a provider or endpoint and uses the applicable feature.\n\n## Data inventory\n\n| Inventory entry | Data type | Linked to identity | Used for tracking | Purpose | Collection and condition | Destination | Code evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n${inventoryRows()}\n\n## Your choices\n\n- Product-usage telemetry does not send until an endpoint is configured and the current disclosure receipt is acknowledged; it can be disabled.\n- OTel does not export until an OTLP endpoint is configured.\n- Knowledge stays in Station's local storage unless a remote embedding provider is configured.\n- Camera and microphone access occur only when their respective pairing or voice features are started.\n\n## Contact and public URL\n\n- Published at: https://kontourai.io/privacy/station/\n- Contact: hello@kontourai.io\n\nThe published page is a public projection of this inventory: it states the same facts without the contributor-oriented code-evidence paths. It records the fingerprint of the rendered policy it was generated from, so a change here makes that page visibly stale rather than quietly wrong. Regenerate and republish it in the same change that alters what Station collects.\n`;
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
