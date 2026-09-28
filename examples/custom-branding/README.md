# Custom Branding Example

Provides server-side branding through a plain CommonJS provider factory.

## What it does

Once admitted, the `branding` provider supplies:
- **App name**: "Station" → "Project Station"
- **Logo**: adds a custom logo with alt text
- **Welcome message**: custom onboarding text

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
