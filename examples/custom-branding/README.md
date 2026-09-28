# Custom Branding Example

Shows how a plugin can override Station's default branding using the provider system.

## What it does

Registers a `branding` provider that replaces:
- **App name**: "Station" → "Project Station"
- **Logo**: adds a custom logo with alt text
- **Welcome message**: custom onboarding text
- **Theme**: a blue white-label accent, with separate values for dark and light mode

## Install

```bash
cp -r examples/custom-branding .station/plugins/custom-branding
```

Then restart the server or hit `POST /api/plugins/reload`.

## Verify

```bash
curl http://localhost:4310/api/branding
# → {"success":true,"data":{"name":"Project Station","logo":{"src":"/favicon.png","alt":"Station"},"theme":{"dark":{…},"light":{…}},"welcomeMessage":"Welcome to Project Station — your AI-powered workspace"}}
```

The header, onboarding gate, and workspace view will all reflect the new branding,
and buttons, accents and focus rings take the theme's colours in both modes.

## Theme overrides

`getTheme()` returns white-label overrides for the `@kontourai/ui` brand slot and
interaction roles. The rules come from the "White-label overrides" section of
[`@kontourai/ui`'s DESIGN.md](https://github.com/kontourai/ui/blob/main/DESIGN.md#white-label-overrides).

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

In the UI: **Plugins → custom-branding → Providers → toggle branding off**

Or via API:
```bash
curl -X PUT http://localhost:4310/api/plugins/custom-branding/overrides \
  -H 'Content-Type: application/json' \
  -d '{"disabled":["branding"]}'
```

## Structure

```
custom-branding/
├── plugin.json              ← declares the branding provider
├── providers/
│   └── branding.js          ← IBrandingProvider implementation
└── README.md
```

The provider module exports a factory function that returns an object implementing `IBrandingProvider`. No build step needed — it's plain CommonJS.
