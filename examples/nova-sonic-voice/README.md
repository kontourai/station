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

Models: `us.amazon.nova-lite-v1:0`, `us.amazon.nova-pro-v1:0`

## Files

- `plugin.json` — declares `conversational` provider type, requires `aws:bedrock` permission
- `plugin.mjs` — structural-only server WS relay endpoint at `/api/plugins/nova-sonic-voice/relay`
- `src/NovaSonicProvider.ts` — preview ConversationalVoiceProvider shape for STT + TTS in one bidirectional session
- `src/index.ts` — registers provider into `voiceRegistry` on load

## Status

The relay in `plugin.mjs` intentionally returns 501 and remains structural-only. It does not
perform the full WS-to-Bedrock `InvokeModelWithBidirectionalStream` bridge, so this example is
unavailable for real voice until that bridge exists.

The client-side `NovaSonicProvider.ts` is a preview provider shape, not a complete working
reference implementation. It sketches audio chunking, turn-taking, and interrupts against the
future relay contract.
