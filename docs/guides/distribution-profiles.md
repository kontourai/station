# Distribution profiles

A distribution profile controls which layout catalog entries Station presents on
first run and during later catalog reads. It is policy, not proof that a plugin is installed: Station joins the
profile with installed lifecycle state before it enables an action.

## Built-in profiles

`standard` is the default. Coding, Tasks and Session Board have installed and
enabled catalog defaults; they do not require a separate plugin installation.
Review is another built-in entry, initially installable rather than enabled.
The profile also admits layouts from installed local plugins, subject to their
current installation readiness. It does not fetch a registry to render them.
`minimal` includes no catalog sources, so it intentionally
exposes no layout entries until an administrator supplies a profile.

## Organization profiles

An organization may provide an inline `distributionProfile` in Station's app
configuration. Source URLs are declarative; they are not fetched while the
catalog is rendered. Local source paths must be relative. Remote sources accept
HTTP(S) URLs without embedded user-info credentials, but remain declarations for
a future adapter: the current catalog only produces built-in and local entries.
Adding a remote URL does not populate a remote layout catalog.

Use `{ "kind": "local", "source": "plugins" }` to allow layouts from every
installed plugin, or `plugins/<plugin-name>` to allow one. Omitting local sources
is a real whitelist: installed plugin layouts outside the selected sources do
not appear as ready or become applicable.

```json
{
  "distributionProfile": {
    "id": "acme",
    "registrySources": [{ "id": "builtin", "kind": "builtin" }],
    "itemPolicies": {
      "builtin:coding": { "visible": true, "preinstalled": true, "enabled": true },
      "builtin:tasks": { "visible": false },
      "builtin:session-board": { "visible": false },
      "builtin:review": { "visible": false }
    }
  }
}
```

Use `visible` to hide an entry. `preinstalled` and `enabled` set lifecycle
defaults whenever no explicit lifecycle override exists. Built-in entries missing from
`itemPolicies` default to visible and installable, so a curating profile must
list every builtin it wants hidden — including builtins added in later Station
versions. Users can later enable,
disable, install, or remove eligible entries in Registry → Layouts; those
explicit choices are persisted separately and do not rewrite profile policy.

## Lifecycle and trust boundary

Registry badges describe the current lifecycle honestly: `installable`,
`disabled`, or `installed`. Only installed and enabled layouts appear in a
project's Add Layout picker, and applying one always calls the server's catalog
operation. A visible entry never auto-installs, executes plugin code, or grants
permission to bypass plugin validation.

For built-ins, install/remove changes a lifecycle override; it does not download
or delete their implementation. Installed plugin layouts instead depend on the
observed package and readiness state. Overrides live separately in
`config/distribution-lifecycle.json`. A cached catalog is an observation;
applying a layout resolves it again through the live owner.

The [profile contract](../../packages/contracts/src/distribution.ts),
[built-in catalog](../../packages/contracts/src/layout.ts), and
[profile service](../../src-server/services/plugins/distribution-profile-service.ts)
own defaults and projection. [Project routes](../../src-server/routes/projects/projects.ts)
own application and current request authority; catalog visibility is not a grant.

For plugin authoring and explicit plugin installation, see the
[Plugin Guide](./plugins.md). Deployment operators should keep profile and
Station home configuration under their normal configuration-management controls;
see the [Deployment Guide](./deployment.md).

## Marketplace sources

The Registry's connected marketplaces are a separate discovery input over the
same installed plugin lifecycle. [Source management](../reference/api.md#manage-marketplaces)
adds catalogs; it does not grant, install or enable every entry. Distribution
profiles still decide which installed layouts a Project can use. Removing or
disabling a marketplace preserves installed packages and profile policy.
