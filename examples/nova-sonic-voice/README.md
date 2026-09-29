# nova-sonic-voice — example plugin

Preview example of an Amazon Nova Sonic conversational voice plugin shape.

Nova Sonic uses AWS Bedrock `InvokeModelWithBidirectionalStream` (HTTP/2), which cannot be
called directly from the browser. This plugin's server module is structural-only today: it
declares the WebSocket relay shape, but it is unavailable for real voice until the
WS-to-Bedrock bridge is built.

```
Browser WS <-> plugin.mjs relay <-> AWS Bedrock HTTP/2
```

Required IAM permission: `bedrock:InvokeModelWithBidirectionalStream`

The manifest currently lists Nova Lite/Pro model IDs as placeholders. They are
not a qualified Sonic configuration; the [AWS Sonic model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-sonic.html)
names `amazon.nova-sonic-v1:0`. Model selection, region support and authorization
must be reconciled when implementing the bridge.

## Files

- `plugin.json` — entrypoint, server module (`plugin.server` permission) and the `region` and `model` settings the relay reads
- `plugin.mjs` — structural-only server WS relay endpoint at `/api/plugins/nova-sonic-voice/relay`
- `src/NovaSonicProvider.ts` — preview ConversationalVoiceProvider shape for STT + TTS in one bidirectional session
- `src/index.ts` — `activate({ apiBase })` registers the provider into `voiceRegistry` and returns the disposer the plugin host calls on reload or disable

## Status

The relay returns 426 without a WebSocket upgrade header, 503 when its dynamic
AWS SDK import is unavailable, and otherwise 501. It remains structural-only and does not
perform the full WS-to-Bedrock `InvokeModelWithBidirectionalStream` bridge, so this example is
unavailable for real voice until that bridge exists.

The client-side `NovaSonicProvider.ts` is a preview provider shape, not a complete working
reference implementation. It sketches audio chunking, turn-taking, and interrupts against the
future relay contract. Activation creates separate legacy STT and TTS instances;
it does not establish a shared bidirectional audio session. The separate core
Nova service and smoke do not qualify this example's stub relay.
