# Build Your First Plugin

There are two paths to a working plugin, and which one you can use depends on
what you have:

- **[Start from npm](#start-from-npm)** — Node 24, npm, a TypeScript-aware build
  runner and compatible `@kontourai/station-sdk` / `@kontourai/station-shared`
  packages. Use this if you do not have a Station checkout.
- **[Scaffold with the CLI](#choose-a-template)** — the published Station CLI
  creates a template and runs the watching dev server. A checkout's `./station`
  launcher is an equivalent source-development path.

The Pane examples produce a `plugin.json` manifest and a `dist/bundle.js`
built by `buildPlugin()`. A provider-only plugin can omit a UI entrypoint and
bundle. The commands below describe the source contract; they are not evidence
that a particular registry version is published or that an installed plugin
has been approved and activated.

For a portable Workspace Pane declaration, also read
[Author Workspace Pane Contributions](./workspace-pane-authoring.md). It
explains identity, placement, provenance, renderer capabilities, and the
standalone conformance command.

## Start from npm

Create the project and install the two published packages:

```bash
mkdir hello-station && cd hello-station
npm init -y
npm pkg set type=module
npm pkg set scripts.build="tsx build.ts"
npm pkg set scripts.dev="tsx build.ts --dev"

npm install @kontourai/station-sdk @kontourai/station-shared
npm install -D tsx @types/react

mkdir src
```

This example uses `tsx` because the packages expose TypeScript source and Node
does not strip types under `node_modules`. Other source-aware build runners can
serve that role. Use Node 24, as required by the shared package's engine range.

Write the manifest Station reads, `plugin.json`. It is an
[Agent Plugins 1.0](https://agent-plugins.org) manifest; Station's own fields
live under `extensions["io.kontourai.station"]`, and the UI is one Workspace
Pane:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "hello-station",
  "version": "1.0.0",
  "description": "A Station Workspace Pane",
  "extensions": {
    "io.kontourai.station": {
      "schemaVersion": "1.0",
      "title": "Hello Station",
      "sdkVersion": "^0.7.0",
      "entrypoint": "./src/index.tsx",
      "capabilities": ["navigation"],
      "permissions": ["navigation.dock"],
      "workspacePanes": [
        {
          "version": "1.0",
          "id": "pane:plugin%3Ahello-station:main:workspace",
          "name": "Hello Station",
          "rendererId": "renderer:plugin%3Ahello-station:plugin-component:workspace",
          "renderer": { "kind": "plugin-component", "name": "hello-station-workspace" },
          "placement": { "supportedRegions": ["primary"], "preferredRegion": "primary" },
          "modes": [{ "id": "default", "contextRequirement": { "project": true } }],
          "provenance": { "origin": "plugin", "pluginId": "hello-station" },
          "lifecycle": { "stage": "stable" }
        }
      ]
    }
  }
}
```

The entrypoint, `src/index.tsx`. Export a `components` map keyed by each
Pane's `renderer.name`. Every plugin's components share one host registry,
so prefix the keys with the plugin name:

```tsx
import { useNavigation } from '@kontourai/station-sdk';

function Workspace() {
  const { setDockState } = useNavigation();
  return (
    <section style={{ padding: '1.5rem' }}>
      <h1>Hello Station</h1>
      <button type="button" onClick={() => setDockState(true)}>
        Open Chat
      </button>
    </section>
  );
}

export const components = { 'hello-station-workspace': Workspace };
export default Workspace;
```

And the build, `build.ts`. `buildPlugin()` is the same function the Station CLI
and the Station server both call:

```ts
import { buildPlugin } from '@kontourai/station-shared/build';

const mode = process.argv.includes('--dev') ? 'dev' : 'production';
const result = await buildPlugin(process.cwd(), mode);

if (!result.built) console.log('No entrypoint in plugin.json — nothing to bundle.');
else console.log(`Built ${result.bundlePath}`);
```

Build it:

```bash
npm run build
```

```text
Built /path/to/hello-station/dist/bundle.js
```

`npm run dev` produces `dist/bundle-dev.js` with inline sourcemaps. Both are
one-shot builds; the watching preview server is CLI-only (see
[Start With a Pane Plugin](#start-with-a-pane-plugin)).

### Load it into Station

Use a compatible Station CLI to preview the source, review the requested
permissions and dependencies, and submit the resulting approval:

```bash
station plugin install "$PWD"
```

The CLI permits a local path only when its resolver selects `active-local`
(the automatically discovered local instance) or the default `loopback`
fallback. This tests resolution provenance, not the URL's hostname: even an
explicit `--api-base` loopback URL or a saved localhost Station has a different
source and is refused for local directories. Other target sources require a
Git URL; a shared filesystem path does not bypass the rule. Configure the
selected Station and its credential through the CLI's normal connection flow.

The HTTP flow uses authenticated `POST /api/plugins/preview`, followed by
`POST /api/plugins/install` carrying the reviewed permissions, content digest,
grant revision and dependency approvals. Do not substitute empty permission
lists or a placeholder digest. See the SDK's
[complete consent example](../reference/sdk.md#useplugininstallmutation) for the
request shape; the server rechecks requirements against the submitted approval.

Installation stages and builds content and records grants. Passive permissions
are auto-granted; reviewed active permissions are bound to the installed tree.
Trusted permissions remain pending for separate host-owned review. Approval
does not itself prove runtime activation: reconciliation can withhold plugin
content when grants or bytes do not match. Once admitted, a Workspace Pane can
be added to a Project through **Add pane**. See
[plugins.md](./plugins.md#installation-flow) for the rest of the plugin HTTP
API.

## Choose a Template

The rest of this guide uses the published CLI. Install it once, then confirm
the version before scaffolding:

```bash
npm install -g @kontourai/station-cli@latest
station --version
```

This guide describes current `main` and targets the published 0.7 SDK/shared
line. A released CLI can lag `main`; inspect the generated `package.json` and
upgrade its Station package ranges when you intentionally target a newer
published contract.

Use the template that matches the job:

```bash
station plugin create hello-pane --template=pane
station plugin create provider-kit --template=provider
station plugin create full-workspace --template=full
```

- `pane` creates a UI plugin with one Workspace Pane, its entrypoint and CSS.
- `provider` creates a server-side plugin with `plugin.mjs`, a `serverModule`, and a sample provider file.
- `full` creates the combined starter: two Panes, an Agent, build config, and README.
- `layout` is an alias for `pane`.

Every template writes an Agent Plugins 1.0 `plugin.json`. Station can also
create the same scaffold from **Plugins → New plugin**, which makes the
Project for you.

`station plugin init` still works, but it is now just a compatibility alias for the `full` template.

## Start With a Pane Plugin

Run `station plugin create hello-pane --template=pane` from the directory
where you want the plugin scaffolded. The plugin command family resolves
`plugin.json` and other paths from the directory where you invoke it:

```bash
cd hello-pane
npm install
npm run build                              # tsx build.ts → dist/bundle.js
```

The scaffold's `npm run build` runs its own `build.ts`, which calls
`buildPlugin()` from `@kontourai/station-shared` — the same call
`station plugin build` wraps.

`station plugin dev` previews legacy layout tabs only; it does not render
`workspacePanes` yet, so install the plugin to see its Pane. For a legacy
layout plugin, `station plugin dev 4300` adds watching, hot rebuilds, the
preview shell, and the mock host surface described below.

Open `http://127.0.0.1:4300` and keep the dev server running. The dev server binds only to IPv4 loopback; direct `--host`/non-loopback exposure is unavailable. For a remote development host, forward the loopback listener with `ssh -N -L 4300:127.0.0.1:4300 user@dev-host` and open the same local URL. The dev server:

- builds the plugin in dev mode
- watches `src/` and config files for reloads
- regenerates the preview shell when layout or manifest files change
- exposes a restricted, same-origin development fetch/tool surface

The fetch proxy permits public HTTP(S) only, validates all DNS answers and each redirect, strips credential and hop-by-hop headers, forces identity encoding (encoded upstream responses are rejected), and rejects private/loopback/link-local/metadata targets. JSON requests are limited to 1 MiB, identity fetch responses to 10 MiB, each DNS-through-response hop to 10 seconds and five redirects, and reload streaming to 32 clients.

## Install It Into Station

Install from either the parent directory of `hello-pane` or the plugin directory itself:

```bash
station plugin install ./hello-pane
# Or, from inside hello-pane:
station plugin install .
```

Local paths are resolved from the directory where Station was invoked. Use
`./hello-pane` from its parent or bare `.` from inside the plugin directory,
with automatically resolved `active-local` or default `loopback` provenance.
An explicit API-base flag or saved Station selection requires a Git URL even
when its URL is local. This is the CLI's source-selection rule, separate from
the authenticated server API's source and filesystem admission.

If you are working from a Station checkout and want to test the repository's
registry fixture too, point its source launcher at the bundled local manifest:

```bash
./station registry ./examples/registry/manifest.json
./station registry install demo-layout
```

Read `plugins[].id` in `examples/registry/manifest.json` for the current fixture entries.

The local fixture is reproducible from a checkout and is covered by:

```bash
npm run proof:registry-manifest
```

This proves the reproducible local fixture and hosted-compatible manifest
resolution paths. Phase 2 was explicitly closed on local-fixture scope; a
hosted registry is separate publication/distribution work and must not be
claimed from this local proof.

## Add Server Logic

Provider-style plugins can declare server routes through `serverModule`.
This is a legacy Station manifest excerpt; in an Agent Plugins 1.0 manifest,
put the Station fields under `extensions["io.kontourai.station"]` as above:

```json
{
  "name": "provider-kit",
  "version": "1.0.0",
  "displayName": "Provider Kit",
  "serverModule": "./plugin.mjs",
  "providers": [
    { "type": "branding", "module": "./providers/branding.js" }
  ]
}
```

Your `plugin.mjs` can register routes plus request lifecycle hooks:

```js
export const hooks = {
  onRequest({ correlationId, path }) {
    console.log('request', correlationId, path);
  },
  onResponse({ correlationId, status }) {
    console.log('response', correlationId, status);
  },
};

export function register(app, context) {
  app.get('/ping', (c) =>
    c.json({
      ok: true,
      plugin: context.pluginName,
      correlationId: c.req.header('x-station-correlation-id') || null,
    }),
  );
}
```

Routes are mounted under `/api/plugins/<plugin-name>/...`. The registration context gives you `pluginName`, `projectHomeDir`, `logger`, and config helpers; request correlation IDs are available in request hooks and on the `x-station-correlation-id` header.

Loading `serverModule` requires the trusted `plugin.server` grant; registering
providers requires `providers.register`. Both need the separate host-owned
review and successful reconciliation. This Node server extension is trusted
code, not a sandbox. Declaring it or successfully building a UI bundle does not
prove that its routes or providers have been loaded.

## What To Copy Next

- Use [plugins.md](./plugins.md) for the full manifest reference.
- Use [examples/demo-layout](../../examples/demo-layout/README.md) for a starter workspace example.
- Use [examples/enterprise-layout](../../examples/enterprise-layout/README.md) when you need a larger multi-panel plugin to copy from.
