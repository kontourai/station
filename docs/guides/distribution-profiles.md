# Distribution profiles

A distribution profile controls which layout catalog entries Station presents on
first run. It is policy, not proof that a plugin is installed: Station joins the
profile with installed lifecycle state before it enables an action.

## Built-in profiles

`standard` is the default. It includes the dependency-free Coding and Tasks
starters, both preinstalled and enabled, plus layouts from plugins already
installed in Station's local `plugins` directory. It does not contact a registry
just to render them. `minimal` includes no catalog sources, so it intentionally
exposes no layout entries until an administrator supplies a profile.

## Organization profiles

An organization may provide an inline `distributionProfile` in Station's app
configuration. Source URLs are declarative; they are not fetched while the
catalog is rendered. Local source paths must be relative and remote sources must
be credential-free HTTP(S) URLs.

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
      "builtin:session-board": { "visible": false }
    }
  }
}
```

Use `visible` to hide an entry, `preinstalled` to choose its first-run lifecycle
default, and `enabled` to allow it to be applied. Entries missing from
`itemPolicies` default to visible and installable, so a curating profile must
list every builtin it wants hidden — including builtins added in later Station
versions (`builtin:session-board` above). Users can later enable,
disable, install, or remove eligible entries in Registry → Layouts; those
explicit choices are persisted separately and do not rewrite profile policy.

## Lifecycle and trust boundary

Registry badges describe the current lifecycle honestly: `installable`,
`disabled`, or `installed`. Only installed and enabled layouts appear in a
project's Add Layout picker, and applying one always calls the server's catalog
operation. A visible entry never auto-installs, executes plugin code, or grants
permission to bypass plugin validation.

For plugin authoring and explicit plugin installation, see the
[Plugin Guide](./plugins.md). Deployment operators should keep profile and
Station home configuration under their normal configuration-management controls;
see the [Deployment Guide](./deployment.md).
