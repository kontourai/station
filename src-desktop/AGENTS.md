# Native scope

Read [native shell verification](../docs/guides/native-shell-verification.md) and the relevant platform guide before changing desktop code. Preserve desktop ownership boundaries and Windows-safe process behavior. Native/device proof is separate from unit evidence; do not report it as verified without the physical identity, listener, service, and interaction evidence the guide requires.

Use the focused native check selected by `npm run gate:for`; escalate only when the changed risk requires it.
