# Custom Branding Example

Provides server-side branding through a plain CommonJS provider factory.

## What it does

Once admitted, the `branding` provider supplies:
- **App name**: "Station" → "Project Station"
- **Logo**: adds a custom logo with alt text
- **Welcome message**: custom onboarding text
- **Theme**: a blue white-label accent, with separate values for dark and light mode

## Install

From the repository root, with a running local Station selected by automatic
discovery or the default loopback fallback:

```bash
station plugin preview ./examples/custom-branding
station plugin install ./examples/custom-branding
```

Review the requested `providers.register` permission. This is a trusted
server-code capability and needs the host-owned review described in the
[plugin guide](../../docs/guides/plugins.md#installation-flow). Copying a directory
or reloading plugins does not supply that grant. No UI bundle is needed.

## Verify

An authenticated `GET /api/branding` on the selected Station returns
`{ "success": true, "data": { "name": ..., "logo": ..., "theme": ...,
"welcomeMessage": ... } }`. The
[route](../../src-server/routes/system/branding.ts) resolves the active provider;
the [SDK request](../../packages/sdk/src/query-domains/systemRuntimeRequests.ts)
maps `data.name` to `appName`.

The browser sidebar consumes that name. Native sidebar chrome deliberately
keeps the installed Station/channel identity, so this provider does not rename
every surface. Returning a logo or welcome message does not prove every view
uses it. Installation and rendered branding were not exercised in this audit.

## Theme overrides

`getTheme()` returns white-label overrides for the `@kontourai/ui` brand slot and
interaction roles. The rules come from the "White-label overrides" section of
[`@kontourai/ui`'s DESIGN.md](https://github.com/kontourai/ui/blob/main/DESIGN.md#white-label-overrides);
the [validation](../../src-ui/src/lib/branding-theme.ts) applies a theme that
passes to buttons, accents and focus rings in both modes.

Shape:

```js
{
  '--k-brand': '#…',          // flat keys are expanded into both modes
  dark:  { '--k-action': '#…', '--k-action-contrast': '#…' },  // per mode,
  light: { '--k-action': '#…', '--k-action-contrast': '#…' },  // wins over flat
}
```

What Station accepts:

| Property | Role | Check (per mode, against that mode's page and panel) |
| --- | --- | --- |
| `--k-brand`, `--k-brand-contrast` | Identity accent and the text on a brand fill | brand ≥ 4.5:1 on page and panel; brand/contrast pair ≥ 4.5:1 (an unset half uses the shipped value) |
| `--k-action`, `--k-action-contrast` | Primary action fill and its text | both or neither; pair ≥ 4.5:1; fill ≥ 4.5:1 on page and panel, because Station also uses it as accent text |
| `--k-focus` | Keyboard focus ring | ≥ 3:1 on page and panel |

- Values must be `#rgb` or `#rrggbb`. Named colours, `rgb()`, `var()`, `url()`,
  alpha and anything else are rejected.
- Any other key is rejected. Nothing outside this list is ever written to the page.
- All or nothing: if any key, value or check fails, in either mode, none of the
  theme is applied and the default stays. Each rejection is logged in the
  browser console with a `[branding-theme]` prefix.
- Flat keys are expanded into both modes before checking, so a flat value must
  pass in both. One value rarely does; prefer the `dark` / `light` objects.
- A device accent chosen in **Settings → Appearance** still colours buttons and
  links on that device over the theme's action colour. Focus rings follow the
  theme's `--k-focus` when the theme sets it, and the device accent otherwise.

## Disable without uninstalling

Open the plugin's **Connection types** section and use its branding toggle.
The authenticated `PUT /api/plugins/custom-branding/overrides` operation stores
`{ "disabled": ["branding"] }`. This is a provider override, not whole-plugin
uninstallation; see the [configuration routes](../../src-server/routes/plugins/plugin-config-routes.ts)
and [plugin guide](../../docs/guides/plugins.md) for lifecycle and reload behavior.

## Structure

```
custom-branding/
├── plugin.json              ← declares the branding provider
├── providers/
│   └── branding.js          ← IBrandingProvider implementation
└── README.md
```

The provider module exports a factory function that returns an object implementing `IBrandingProvider`. No build step needed — it's plain CommonJS.
