# Layout stack parity fixture

A test-only plugin (`layout-parity-review-workbench`) for #2995. Its layout declares the
layout contract fields — `primary: "chat"`, `presentation: "stack"` and two
`drillIns` naming its own tabs' panes — and requests the `layout.primaryChat`
permission that the claim needs. `tests/layout-stack-parity.spec.ts` installs
it through the real preview, consent and install API and runs the same
assertions against it and against built-in Coding.

The fixture uses a realistically named plugin and layout. Station issues
bounded occurrence ids for its drill-ins and accepts an exact legacy direct
bookmark from the same Project. The tests open the pane through the stack and
through the legacy bookmark.
