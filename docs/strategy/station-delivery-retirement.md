# Retired station-delivery lifecycle

`station-delivery` was an internal dogfood Flow definition. It is no longer a
runnable definition and was removed from `.flow/definitions/`. Historical run
records retain their stored definition and run identifiers for audit integrity,
while the shared Flow presentation helper renders them as `Legacy delivery checks`
in the run console, attached-run marker, Session detail and event labels.

New work uses the standard Flow/Builder lifecycle selected by the task. The
Project route `POST /api/projects/:slug/flow/runs` rejects `station-delivery`
with HTTP 409 and `flow.definition.retired`. Other definitions proceed through
the normal Flow service and its admission requirements.
