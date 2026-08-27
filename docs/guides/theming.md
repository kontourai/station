# Station theming

Kontour UI owns the shared explorer, generated manifest, consumer guidance,
`--k-*` base-token contract, product themes, and primitive accessibility
behavior. Use the [Kontour UI consumer guide](https://github.com/kontourai/ui/blob/main/docs/consumer-guide.md#explorer)
and [generated explorer manifest](https://github.com/kontourai/ui/blob/main/docs/explorer-manifest.json)
for those contracts and their current values.

Station consumes Kontour UI's public base tokens and themes. It does not own or
duplicate a shared product theme. Station-only channel branding belongs at the
Station adopter boundary: preserve the shared token and accessibility contract,
then apply channel-specific identity without redefining UI's token values,
themes, primitives, or focus behavior.

Station owns only adopter behavior: its domain language, navigation, runtime
data, receipts, and channel branding at the consuming surface.

When a Station surface needs a new visual value or primitive behavior, propose
it through Kontour UI rather than copying a color table, font rule, or component
implementation into Station. Station surfaces retain ownership of their domain
language, navigation, runtime data, and receipts.
