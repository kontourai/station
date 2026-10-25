# Layout stack parity fixture

A test-only plugin (`stack-fx`, not a Kontour plugin) for #2995. Its layout declares the
layout contract fields — `primary: "chat"`, `presentation: "stack"` and two
`drillIns` naming its own tabs' panes — and requests the `layout.primaryChat`
permission that the claim needs. `tests/layout-stack-parity.spec.ts` installs
it through the real preview, consent and install API and runs the same
assertions against it and against built-in Coding.

The plugin and layout ids are deliberately short. A legacy layout tab's
Project occurrence id embeds the Project id, the plugin id and the layout
slug twice over. The pane host's identity-segment check and the navigation
store's `?pane=` selection both refuse an id longer than 128 characters (the
URL routes themselves set no cap), so the parser refuses a drill-in whose
occurrence id would exceed it rather than leave it off the rail (#4130).
