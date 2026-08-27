# OpenAI-compatible Realtime Voice

Plugin activation registers a truthfully unconfigured, disableable adapter.
Inject a transport that mints short-lived authorization to replace it. The
transport keeps the endpoint/token in its lease closure; do not store it in
Station settings, errors, telemetry, or logs.

The plugin pack itself remains transport-injected. The repository's smoke has
a checked-in, server-side reference transport pinned to the OpenAI HTTPS and
WSS origins; it keeps the credential in process only and routes the complete
turn through the common realtime adapter.

Run the credentialed smoke with an explicit provider selection and either an
environment variable or a POSIX mode-0600 credential file:

`OPENAI_API_KEY_FILE=/secure/path/openai-key node scripts/voice-realtime-live-smoke.mjs --provider openai-realtime-compatible`

`OPENAI_API_KEY` remains supported. Missing credentials report
`NOT_VERIFIED`; a supplied credential can produce AC2 evidence only when the
real provider run completes and its receipt is retained.
