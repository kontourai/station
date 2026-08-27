# Station Privacy Policy

*This policy is generated from Station's privacy inventory and published at https://kontourai.io/privacy/station/ , which is the URL the App Store and Play listings point at. If this file and that page disagree, this inventory is right and the page is stale.*

Station is self-hosted. It does not use data for cross-app or cross-site tracking and does not derive its telemetry identifiers from an account. Station sends data away from the device only when a user or operator configures a provider or endpoint and uses the applicable feature.

## Data inventory

| Inventory entry | Data type | Linked to identity | Used for tracking | Purpose | Collection and condition | Destination | Code evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `product-usage-telemetry` | Other Usage Data | false | false | Analytics | Station startup metadata (app version, operating-system platform, and CPU architecture), classified session-recovery outcomes (failure category, recovery decision, and result), and engine-turn terminal outcomes (engine family and completed/aborted result). Delivery occurs only when STATION_TELEMETRY_ENDPOINT is configured, telemetry remains enabled, and the current inventory disclosure receipt exists. | The operator-configured STATION_TELEMETRY_ENDPOINT. A random per-install UUID is SHA-256 hashed before delivery; it is not account-derived. | `src-server/services/usage-telemetry-inventory.ts`, `src-server/services/usage-telemetry-service.ts` |
| `otel-observability` | Performance and Diagnostics | false | false | Analytics | OpenTelemetry metrics and traces, carrying a stable per-install identifier (the SHA-256 of a random UUID stored under STATION_HOME, not derived from the machine or any account), operating-system type, and instrument attributes. Export occurs only when OTEL_EXPORTER_OTLP_ENDPOINT is configured. | The operator-configured OTLP endpoint. | `src-server/telemetry.ts`, `src-server/telemetry/metrics.ts` |
| `knowledge-content` | Other User Content | false | false | App Functionality | Documents and text selected for Knowledge are stored in the Station home and indexed locally. If the user configures a remote embedding provider, document chunks and search queries are submitted to that provider to produce embeddings. | Local Station storage by default; otherwise the user-configured Bedrock, OpenAI-compatible, or Ollama embedding endpoint. | `src-server/services/knowledge/knowledge-documents.ts`, `src-server/providers/lancedb-provider.ts`, `src-server/providers/llm/bedrock-embedding-provider.ts`, `src-server/providers/llm/openai-compat-provider.ts`, `src-server/providers/llm/ollama-provider.ts` |
| `voice-audio` | Audio Data | false | false | App Functionality | Microphone audio from an explicitly started voice session. The mobile client sends it over its authenticated Station voice WebSocket; Station forwards it to the configured speech-to-speech provider. | The user's Station and, for the built-in Nova Sonic provider, Amazon Bedrock. Any browser Web Speech provider handling is platform-defined and is NOT ESTABLISHED here. | `src-ui/src/providers/voice/NovaVoiceSessionAdapter.ts`, `src-server/voice/providers/nova-sonic.ts` |
| `camera-qr-pairing` | Other User Content | false | false | App Functionality | Camera frames are read only while the user opens the QR pairing scanner. The scanner decodes a pairing code in the WebView. | Local WebView processing; the decoded pairing value is used to pair with the user's Station. Camera imagery is not sent to a Station-operated third party by this scanner. | `packages/connect/src/react/QRScanner.tsx` |

## Your choices

- Product-usage telemetry does not send until an endpoint is configured and the current disclosure receipt is acknowledged; it can be disabled.
- OTel does not export until an OTLP endpoint is configured.
- Knowledge stays in Station's local storage unless a remote embedding provider is configured.
- Camera and microphone access occur only when their respective pairing or voice features are started.

## Contact and public URL

- Published at: https://kontourai.io/privacy/station/
- Contact: hello@kontourai.io

The published page is a public projection of this inventory: it states the same facts without the contributor-oriented code-evidence paths. It records the fingerprint of the rendered policy it was generated from, so a change here makes that page visibly stale rather than quietly wrong. Regenerate and republish it in the same change that alters what Station collects.
