# The plugin authority model: contributions, loci, and where consent belongs

Status: design note, 2026-08-25. Written while shaping station#4220 (one plugin
format, user-chosen runtime) and station#4190 (dogfood the iframe tier).

Two independent adversarial reviews corrected the first draft of this note on
several points of fact. Where a claim below is narrower than you might expect,
it is because the broader version did not survive the tree.

## The finding that reframes the rest

**Station has already reached this note's conclusion, in four places, and acted
on it inconsistently.** The gap is not that nobody has thought about plugin
authority; it is that the reasoning is applied in some paths and inverted in
others.

1. `plugin-public-routes.ts` disables the plugin fetch proxy outright, after
   its permission check, with the reason:
   *"Plugin fetch proxy is disabled until plugin execution identity is
   verifiable."* That is the thesis, already concluded and acted on.
2. `MCPToolUIFrame.tsx` warns:
   *"Do not copy Station's shell nonce into untrusted srcdoc content. A script
   can read its effective nonce and reuse it on an undeclared remote script."*
   The plugin path does exactly this, deliberately (below).
3. `plugin-content-integrity.ts` states its own limit — it cannot cover
   *"code the plugin fetches or generates AT RUNTIME after being granted."*
4. `PERMISSION_TIERS` plus the host-approval channel implement a real,
   digest-bound, distinct-origin consent path — for the three contribution
   families the derivation can see.

So the useful sentence is not "Station needs an authority model." It is:
**the machinery works, and it can only see three of the eleven things a plugin
manifest can contribute.**

## What a plugin actually contributes

A plugin is not one thing with one trust level. Its manifest declares
contributions that execute in different places under different authority.

| Contribution | Executes | Authority | Derived permission? |
| --- | --- | --- | --- |
| `layout` / `workspacePanes` | the user's browser | Station's origin: session credential, DOM, shell chrome; under Tauri the allowlisted native capabilities | **none** |
| `entrypoint` (incl. via `dependencies`) | the user's browser | same as above | **none** |
| `agents` | Station server, via an engine | whatever tools, models and project data that agent's own spec declares; indistinguishable at runtime from a hand-authored agent | **none** |
| `serverModule` / `providers` | Station server, `await import()` into the process | filesystem, network, `<STATION_HOME>`, environment | `plugin.server`, `providers.register` (trusted tier) |
| `operationalEventSubscriptions` | Station server, background | event stream; `envelope` projection carries full payloads | `events.subscribe`, `events.read-payload` (trusted tier) |
| `integrations.required` | a child process on the host | the Station user's account — **but the `command`/`args` come from the integration registry, not from the plugin** | none for the requirement itself |
| `knowledge.namespaces` | Station server | project-scoped, but the namespace is not the plugin's: any agent may read and write it, and uninstall does not remove it | none |
| `prompts` | injected into agent context | shapes agent behaviour invisibly at use time | none |
| `settings` (`secret: true`) | Station server | declaring a field creates a plaintext credential store; redaction covers the GET route, not the value handed to `register()` | none |

Fields that are **declared but compute nothing** — worth knowing before
reasoning about them: `skills` (no manifest consumer; real skill discovery is a
filesystem walk for `SKILL.md`), `tools.required` (only `integrations.required`
is consumed), `capabilities`, and `layouts` on the canonical installer path.
`build` throws outright.

Three corrections to the obvious reading of that table:

- **The plugin does not supply the MCP command line.** `integrations.required`
  is a string id naming a requirement against a separately maintained
  registry; the `command`/`args` that get spawned come from
  `<home>/integrations/<id>/integration.json`. The arbitrary-code-execution
  claim belongs to `serverModule`, which really is a dynamic import into the
  server process — and which, unlike integrations, *does* carry a derived,
  trusted-tier, host-approval-gated permission.
- **`dependencies` install transitively under one gesture**, capped to
  essentially `entrypoint` — which is in-process root-document code for which
  the derivation emits nothing. The transitive surface is arbitrary browser
  code, zero derived consent, approved as a sub-line of another install.
- **`agents` is the largest uncovered contribution.** `agents.invoke` exists as
  a permission but is never auto-added for `manifest.agents`.

## Ranking the danger honestly

The first draft said the pane is the least dangerous contribution. That is not
defensible; it collapses two axes.

**Authority × acquisition cost.** A `serverModule` has the highest authority
and the highest cost: trusted tier, a distinct-origin consent transaction, a
content digest, `access:manage`. A pane has moderate authority and **near-zero
cost** — no tier, no approval, no grant. A real attacker ships a pane.

The pane is also the only contribution holding all three of: the operator's
live session credential; the operator's **attention**, since it draws pixels
inside Station's own chrome; and **per-device** blast radius, since it executes
wherever it renders rather than on the one host the operator controls.
Phishing a re-auth prompt, reading the composer, and localStorage persistence
are pane-only.

The irony is in the tree. `ui.confirm` is an *active*-tier permission because
*"the shell's confirm chrome is a focus-trapping, full-viewport overlay
rendered in Station's own authority, and the requesting plugin supplies its
body text."* An **in-process pane needs no grant at all** to draw the same
overlay itself. Station charges a permission for a weaker version of what a
pane gets free.

## Where consent belongs

Install time is the natural moment for accepting a package, and accepting a
vendor's code into your origin is an ordinary trade. But three facts stop it
being sufficient on its own, and the first is not a design gap but a bug:

**1. ~~Consent is currently requested *after* installation.~~ Fixed
(station#4288, 2026-08-26).** The install flow used to mutate first and prompt
second, and declining left the plugin installed — for the browser-resident
contributions the prompt was not a gate at all. The decision is now a
PARAMETER of `POST /api/plugins/install`: the operator answers on what the
preview staged and derived, and the installer re-derives both from its own
staged copy — the permission set AND a `computePluginContentDigest` over the
whole tree — before anything outside the staging directory is touched. A
refusal therefore leaves nothing, because nothing had happened.

The digest is what carries the eight contributions the permission derivation
cannot see: a decision about `entrypoint` or a pane is a decision about bytes,
and bytes are what it binds.

What it does NOT claim, stated precisely because the first version of this
paragraph understated it. The gate establishes sequence and binding **for
Station's own client**. Against an arbitrary caller holding a Station
credential it establishes neither: every value a decision carries is readable
from `POST /api/plugins/preview`, so a caller can preview, echo the digest and
the permission set into `/install`, and install with no operator in the loop.
That is not only browser-resident plugin code — a server-side agent with a
shell tool, a paired device, and an exported CLI credential all qualify, and
none of them needs a browser. Nothing in an HTTP request can attest that a
person answered. What the gate is worth is that the product's own path is now
honest, and that an install which skipped the question is distinguishable from
one that did not.

The callers that hold no decision say so rather than manufacturing one, and are
refused whatever they could not have disclosed — on BOTH axes: a
consent-needing permission, or any declared `entrypoint`, `layout`,
`workspacePanes`, `agents` or `dependencies`. `POST
/api/registry/plugins/install` is such a caller, so a registry plugin that
contributes browser code is now refused there rather than installed on one
click; giving the Registry view the same preview-then-approve flow the Plugins
view has is its own change. The MCP `install_plugin` tool is another: it has no
person in its loop, so it refuses and names the Plugins page instead of echoing
a preview back into an install. And the update route still replaces code
without re-deriving or re-prompting (point 3 below).

**2. A CSP exists and hands its own key to the untrusted code.** The served
HTML carries `default-src 'none'; script-src 'self' 'nonce-<per-response>'
'wasm-unsafe-eval'`, with a fresh nonce per response, pinned by an E2E test;
the desktop app carries an equivalent policy. Then:

```ts
const script = document.createElement('script');
script.textContent = `${source}\n//# sourceURL=${url}`;
const nonce = resolveCspNonce();
if (nonce) script.nonce = nonce;      // ← the shell's nonce, to plugin code
document.head.appendChild(script);
```

A script holding the nonce can mint further nonce'd scripts, remote ones
included. `eval` is blocked, but the nonce makes eval unnecessary. So the
policy constrains everything except the code it was needed for — and the repo
already documents precisely this reasoning, in the *other* plugin path, as a
thing not to do.

**3. Updates launder consent.** The update route replaces code, agents,
integrations and providers under the content lock without re-deriving
permissions, comparing digests, or re-prompting.

The consequence is that "the bundle is static until an update" — the property
that would make install-time review sufficient — is not true in either
direction: code can arrive at runtime, and updates arrive without review.

## Why enforcement needs a boundary, precisely

The missing ingredient is **attributable identity**, and Station has already
said so by disabling the one route that lacked it.

Two properties defeat enforcement for an in-process contribution:

1. **Nothing forces the plugin through the enforcement point.** Code in
   Station's document can call the target API directly with the session's own
   credential.
2. **Station hands plugins the credentialed client.** The shared-externals
   table exposes `@kontourai/station-sdk/client` — where `authenticatedFetch`
   resolves a module-global credential — to every bundle. The plugin API is
   not merely declinable; the credential is supplied.

That is why in-realm attribution schemes fail: an SDK wrapper, an import map
or a `Proxy` over globals are all offered to code that can reach the
un-wrapped originals. What cannot satisfy them is a `<script>` tag in your own
document.

**But attribution is necessary, not sufficient** — and the frame proved it.
The frame *does* attribute (origin and WindowProxy both pinned), and its
`api-request` bridge was still wrong, because it authorized on the permission
the caller **named** rather than the resource it **asked for** (station#4275).
So the typed, resource-shaped vocabulary work (station#3534) belongs
*alongside* the boundary, not after it.

> **Superseded, 2026-08-25 (station#4300).** The `api-request` bridge is
> deleted, not hardened: it had no producer, its reply was never deliverable
> to plugin code, it forwarded neither body nor headers, and the only
> permission that reached a real surface through it — `plugin.server` — already
> grants an `await import()` into the server process. The argument above still
> holds as the reason a future frame→shell operation must be resource-shaped;
> it no longer describes any code. A plugin needing a Station operation gets a
> declared pane-host contract member, reviewed on its own merits.

## What consent is attached to

The layer the first draft missed, and the one that decides whether the others
hold. Station has **three incompatible answers** today:

- a permission **name** (`plugin-grants.json`),
- a content **digest** (the host-approval fingerprint),
- an **origin string** in `localStorage` (`allowRemoteBundles`, device-local —
  so one device can admit a remote Station's bundles into its own root webview,
  and previously-admitted code can rewrite that store itself).

They disagree about what invalidates them. Whether an update, a settings
change, or a new device re-prompts is a consequence of this choice, not a
separate feature. Revocation and update-consent are downstream of it.

**Audit is genuinely absent.** There is a counter of plugin server requests by
plugin, method and status. Nothing records what a plugin *did*. After an
incident, an operator cannot answer "what did this plugin read?"

## A threat no disclosure can express

Every plugin bundle's runtime shim executes:

```js
var require = globalThis.require = function(m) { return __shared[m] … };
```

unconditionally, while the host installs its own shim only `if (!window.require)`.
So the first plugin loaded owns `require` for every plugin loaded after it, and
plugin B resolves `react`, `@kontourai/station-sdk/client`, `dompurify` and
`zod` through whatever plugin A left behind. Isolated plugins share a frame
origin with each other and with MCP Apps, so the sandbox separates
plugin-from-Station, not plugin-from-plugin.

This matters to the epic's framing: it is not a plugin↔Station question, so no
install-time disclosure can state it. It is a direct argument against
"disclose fully and run in-process" as a complete answer — you cannot disclose
to plugin B what plugin A will do to it.

## Prior art worth stealing, by mechanism

- **Browser extensions (MV3)** — the closest analogue. **Isolated worlds**: a
  content script shares the DOM but not the JS realm, which is exactly the
  "same pixels, different realm" property a pane needs and that a `<script>` in
  head forfeits. **Host permissions as URL patterns**, granted per-origin and
  enforced at the network layer rather than as a capability name asserted at
  call time — that is the precise fix for station#4275. Plus
  `optional_permissions` for runtime escalation, and **disable-on-permission-
  increase at update**, which is the update-consent flow we need, field-tested.
- **VS Code** — the honest negative lesson. It took the "disclose and trust"
  branch and then built around it anyway: the extension **host is a separate
  process**, webviews are iframes with their own CSP and no direct API access,
  and Workspace Trust gates execution by *workspace*. The ecosystem that chose
  full trust still refused to let extension code into the UI realm. Station
  currently does what VS Code declined to do; arguing for in-process means
  arguing against that decision explicitly.
- **Figma** — plugin logic in QuickJS in a worker with a proxied API and no
  DOM; plugin UI in a sandboxed iframe that must postMessage to the logic half.
  The lesson is the *split*, and it maps onto the pane/`serverModule` division:
  confine the pane, disclose the `serverModule`.
- **Slack** — **token-per-app with scopes on the token**, so attribution rides
  the credential instead of being asserted by the caller, plus per-scope diffing
  on upgrade. This is the concrete shape of a per-plugin scoped credential.
- **Zapier** — authorization is a **connection** created separately from
  installing the app, so revoking reach does not require uninstalling. That is
  layer 2 done properly: *installed* decoupled from *entitled*.
- **MCP** — the boundary is the server process and the host owns consent
  **per invocation**. Station has no per-invocation consent for anything. Note
  this repo's own MCP-UI path already does the strict thing the plugin path
  does not (`connect-src 'none'` in the inner frame).

## The cheapest path to enforceability

Three changes get most of the value, need no new boundary, and are subsets of
already-scoped work:

1. ~~**Fix station#4275 first.**~~ **Done differently: the bridge is gone**
   (station#4300, 2026-08-25). #4275 landed the path-shaped authorization and
   #4300 then deleted the whole `api-request` surface, so the frame tier is
   enforced by having no credentialed egress at all rather than by a matcher.
   What survives is the reserved-identity guard #4275 produced, now refused at
   install time (`src-server/services/plugins/reserved-plugin-identities.ts`).
   The ordering argument against station#4190 is discharged: shipping more
   plugins into the frame no longer widens this surface.
2. **Stop handing plugins the shell nonce.** Load `bundle.js` by plain
   `<script src>` (it is already same-origin) and drop the nonce assignment.
   This does not stop a `plugin.server` holder serving JS from its own `'self'`
   route, and should not be described as if it does — but it restores the
   "no undeclared remote script" property the policy already advertises.
3. **Attach the digest to ordinary grants.** `computePluginContentDigest`
   exists and is already wired into two consent surfaces. Store it beside each
   grant and compare on load; that delivers update-consent with no runtime
   boundary at all. **Done for grants and for install** (station#4288): a
   grant records the digest it was given against, the read path derives
   `bound`/`unverified`/`changed` from it, and the install decision is checked
   against the same digest before the tree is written. Not done for the update
   route.

Then finish the derivation (station#3396) so the tiering and host-approval
machinery that already works can see the other eight contributions.

## Open questions for the owner

1. **Which honest design, per contribution?** The answer can differ by row: a
   pane is a reasonable candidate for confinement; a `serverModule` is not
   confinable by any UI boundary and can only be disclosed and tiered.
2. **Should install consent ever default to full trust?** Open in the threat
   model; unchanged here. Note that today's flow does not gate at all, which is
   a bug rather than an answer.
3. **Is per-contribution installer entitlement worth building** for a
   single-operator product, or is the existing tier lattice plus operator-versus
   -paired-device sufficient once the derivation covers every contribution?
