# Retired station-delivery lifecycle

`station-delivery` was an internal dogfood Flow definition. It is no longer a
runnable definition and was removed from `.flow/definitions/`. Historical run
records retain their stored definition and run identifiers for audit integrity,
but every user-facing projection renders them as `Legacy delivery checks`.

New work uses the standard Flow/Builder lifecycle selected by the task. The
generic `POST /runs` route rejects `station-delivery` with
`flow.definition.retired`; ordinary Flow definitions remain runnable.
