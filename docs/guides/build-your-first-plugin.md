# Build Your First Plugin

There are two paths to a working plugin, and which one you can use depends on
what you have:

- **[Start from npm](#start-from-npm)** — nothing but npm and the published
  `@kontourai/station-sdk` / `@kontourai/station-shared` packages. Use this if
  you do not have a Station checkout.
- **[Scaffold with the CLI](#choose-a-template)** — the published Station CLI
  creates a template and runs the watching dev server. A checkout's `./station`
  launcher is an equivalent source-development path.

Both produce the same artifact: a `plugin.json` manifest and a
`dist/bundle.js` built by `buildPlugin()`.

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

`tsx` is required, not optional: both packages ship TypeScript source, and Node
will not strip types for files under `node_modules`.

Write the manifest Station reads, `plugin.json`:

```json
{
  "name": "hello-station",
  "version": "1.0.0",
  "sdkVersion": "^0.7.0",
  "displayName": "Hello Station",
  "description": "A Station layout plugin",
  "entrypoint": "src/index.tsx",
  "capabilities": ["navigation"],
  "permissions": ["navigation.dock"],
  "layout": { "slug": "hello-station", "source": "./layout.json" }
}
```

The layout it points at, `layout.json`:

```json
{
  "name": "Hello Station",
  "slug": "hello-station",
  "icon": "👋",
  "tabs": [{ "id": "home", "label": "Home", "component": "hello-station-home" }]
}
```

The entrypoint, `src/index.tsx`. Export a `components` map keyed by the tab
`component` ids in `layout.json`:

```tsx
import { type LayoutComponentProps, useNavigation } from '@kontourai/station-sdk';

function Home({ onShowChat }: LayoutComponentProps) {
  const { setDockState } = useNavigation();
  return (
    <section style={{ padding: '1.5rem' }}>
      <h1>Hello Station</h1>
      <button type="button" onClick={() => { setDockState(true); onShowChat?.(); }}>
        Open Chat
      </button>
    </section>
  );
}

export const components = { 'hello-station-home': Home };
export default Home;
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
  dist/bundle.js  3.6kb

⚡ Done in 23ms
Built /path/to/hello-station/dist/bundle.js
```

`npm run dev` produces `dist/bundle-dev.js` with inline sourcemaps. Both are
one-shot builds; the watching preview server is CLI-only (see
[Start With a Layout Plugin](#start-with-a-layout-plugin)).

### Load it into Station

The simplest way is the CLI, which does the whole sequence for you — it
previews the source, prints what installing it would require, and asks:

```bash
npx @kontourai/station-cli@latest plugin install "$PWD"
```

Over HTTP it is two calls, because an install carries the approval a preview
produced (station#4288) and `POST /api/plugins/install` refuses without one:

```bash
curl -X POST http://localhost:3141/api/plugins/preview \
  -H 'Content-Type: application/json' \
  -d "{\"source\": \"$PWD\"}"
# → read `permissions` and `contentDigest`, then:
curl -X POST http://localhost:3141/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d "{\"source\": \"$PWD\", \"consent\": {\"permissions\": [], \"contentDigest\": \"sha256:…\", \"dependencies\": []}}"
```

The CLI uses the selected saved Station and its OS-keyring credential. Station
copies the plugin to `<STATION_HOME>/plugins/<name>/`, rebuilds it, and
registers its layout, which you can then add to a project from the Plugins
screen. Passive permissions are auto-granted, active ones named in the approval
are recorded against the installed tree, and trusted ones come back as
`pendingConsent` for a separate host-owned review. See
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
station plugin create hello-layout --template=layout
station plugin create provider-kit --template=provider
station plugin create full-workspace --template=full
```

- `layout` creates a UI-focused plugin with a layout manifest and entrypoint.
- `provider` creates a server-side plugin with `plugin.mjs`, a `serverModule`, and a sample provider file.
- `full` creates the combined starter: layout, agent, build config, and README.

`station plugin init` still works, but it is now just a compatibility alias for the `full` template.

## Start With a Layout Plugin

Run `station plugin create hello-layout --template=layout` from the directory
where you want the plugin scaffolded. The plugin command family resolves
`plugin.json` and other paths from the directory where you invoke it:

```bash
cd hello-layout
npm install
npm run build                              # tsx build.ts → dist/bundle.js
station plugin dev 4300                    # watching preview server
```

The scaffold's `npm run build` runs its own `build.ts`, which calls
`buildPlugin()` from `@kontourai/station-shared` — the same call
`station plugin build` wraps.
`plugin dev` is the CLI-only part: it adds watching, hot rebuilds, the preview
shell, and the mock host surface described below.

Open `http://127.0.0.1:4300` and keep the dev server running. The dev server binds only to IPv4 loopback; direct `--host`/non-loopback exposure is unavailable. For a remote development host, forward the loopback listener with `ssh -N -L 4300:127.0.0.1:4300 user@dev-host` and open the same local URL. The dev server:

- builds the plugin in dev mode
- watches `src/` and config files for reloads
- regenerates the preview shell when layout or manifest files change
- exposes a restricted, same-origin development fetch/tool surface

The fetch proxy permits public HTTP(S) only, validates all DNS answers and each redirect, strips credential and hop-by-hop headers, forces identity encoding (encoded upstream responses are rejected), and rejects private/loopback/link-local/metadata targets. JSON requests are limited to 1 MiB, identity fetch responses to 10 MiB, each DNS-through-response hop to 10 seconds and five redirects, and reload streaming to 32 clients.

Edit `src/index.tsx` and `layout.json`, then confirm the preview reloads cleanly.

## Install It Into Station

Install from either the parent directory of `hello-layout` or the plugin directory itself:

```bash
station plugin install ./hello-layout
# Or, from inside hello-layout:
station plugin install .
```

Local paths are resolved from the directory where Station was invoked. Use `./hello-layout` from its parent or bare `.` from inside the plugin directory.

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

Provider-style plugins can expose request-scoped server routes through `serverModule`:

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

## What To Copy Next

- Use [plugins.md](./plugins.md) for the full manifest reference.
- Use [examples/demo-layout](../../examples/demo-layout/README.md) for a starter workspace example.
- Use [examples/enterprise-layout](../../examples/enterprise-layout/README.md) when you need a larger multi-panel plugin to copy from.
