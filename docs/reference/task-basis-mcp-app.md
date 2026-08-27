# Whole Task Basis MCP App

Station serves the read-only `station-control/get_task_basis` portable App at
`ui://station/basis/task/v3`. It is self-contained with network-denying CSP and
is available only in Station web hosts; native shells keep the native Basis pane.

A private code-issued read session binds each page to the exact Task,
authenticated caller, and read authority. Result metadata carries opaque
occurrence and continuation values only for the matching session. Tokens rotate,
expire, and revoke on teardown. The App replaces bounded pages rather than
accumulating protected data. Missing, stale, revoked, malformed, or failed
state is generic unavailable, never an inferred empty or partial collection.

Station owns task collection chrome and selected-answer identity. Surface owns
all selected answer Basis semantics. Whole Task has no aggregate standing.
Pages carry separate bounded streams for answers, retained task records, kept
tool results, and Flow-owned kept gate evaluations. An exact association to an
answer on another page is labelled
as such; it is never described as a missing association. An empty association
list means no association with a currently available answer, not proof that no
historical or restricted answer exists.
