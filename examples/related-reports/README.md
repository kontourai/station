# Related Reports

A Station plugin whose **Reports** pane opens each report **beside** the list
as a related pane, through the SDK's related-pane capability
(`useRelatedPanes`; see [Pane relationships](../../docs/design/pane-relationships.md)
and the [SDK reference](../../docs/reference/sdk.md#related-panes)). It is the
dogfood for that capability: the same bundle runs as a trusted direct pane and
inside Station's sandboxed plugin frame.

## What it demonstrates

- `open` names one of the plugin's own descriptors, a mode it declares and the
  plugin's own report key. Station decides where the pane goes: beside the
  list (`destination`), with the Tools (the `tool` role of **Report log**), or
  as a child screen on a phone.
- Opening another report replaces the one preview; opening the same report
  focuses it; **Keep open** on the report turns it into an ordinary tab.
- `reveal` and `close` take the handle `open` returned and act only on what
  this pane opened. `close` asks the report's own unsaved-changes guard.
- The **Report** pane reads the report it was opened for with `target()`.
- Every outcome is a value. On a Station without the capability, or when an
  open is refused, the list shows the report itself and says why.

## Install and try

1. Build it with `station plugin build` in this directory, then install the
   directory with `station plugin install ./examples/related-reports` (or
   through **Plugins → Install plugin**).
2. Open a Project, choose **Add pane**, and open **Reports**.
3. Choose **Open Weekly report**. It opens beside Reports with the opener's
   way back above it.

## Verify

The browser journey is `tests/related-panes.spec.ts`; the host's admission,
placement and refusals are unit-tested in
`src-ui/src/workspace-panes/__tests__/relatedPanesHost.test.tsx`.
