# Shared Providers Example

A provider-only example for auth status, identity, directory lookup and registry
interfaces. Its organization-specific commands, domains and data paths are
placeholders, not configured enterprise integrations. Depending on the package
does not bypass host grants or select every provider automatically.

## Patterns Demonstrated

### Provider-Only Plugin
This plugin has no `entrypoint`, `layout`, or `agents`. It exists solely to contribute providers that other plugins consume. The `providers` array in `plugin.json` maps provider types to JS modules.

### Settings Schema
`plugin.json` declares `authDomain`, `debug` and `disablePublicRegistries`
settings with text/boolean shapes. The host passes saved settings to provider
factories, but these example factories do not read that argument. Changing
those fields therefore does not configure the supplied implementations. Some
providers read environment variables directly; wire settings explicitly when
adapting this example.

### Auth Provider (`oauth-auth`)
Reads expiry metadata from a fixed local token-file path and returns
valid/expiring/expired/missing status. It does not validate the token with an
identity provider. `renew()` returns guidance rather than renewing a token;
prerequisite detection looks for the placeholder `enterprise-auth` command.
Replace the entire organization-specific flow before relying on it.

### User Identity Provider (`ldap-user`)
Returns the server OS username with example-domain profile/email fields. Its
enrichment method attempts a local Agent/tool HTTP call; it keeps the base
identity on failure. The implementation assumes `PORT` or 3141 and supplies no
Station credential. It is not a verified directory lookup for current
authenticated or remote Station deployments.

### User Directory Provider (`ldap-directory`)
Exposes `lookupPerson` and `searchPeople`, attempting local HTTP calls through
an Agent with `directory-mcp`. It has the same target/authentication assumptions
as the identity example, and falls back to an alias-only person or empty list
on failure. Those fallbacks do not prove that the directory has no matching user.

### Integration Registry Provider (`npm-registry`)
`listAvailable()` returns an empty placeholder. The implementation shells out
for global npm installation and writes legacy `tools/<id>/tool.json` records;
it is not the current `integrations/` lifecycle. Removal deletes that local
record rather than uninstalling the global npm package. Treat it as a pattern
requiring redesign against the current managed installation/authority contract,
not a supported production installer.

### Agent Registry Provider (`agent-registry`)
Parses the placeholder `agent-manager agents list` output. Both install and
uninstall return a refusal telling the operator to use that external CLI;
the provider does not invoke those mutations. Missing commands or failed list
calls yield an empty list, not verified absence of packages.

### External Links
The `links` array contributes link metadata. This example's `achievements`
placement is read by the Profile page and displays the placeholder admin
dashboard link when **Milestones** is opened; it does not create a general
sidebar item.

## File Structure

```
shared-providers/
├── plugin.json                        # Manifest: settings, providers, links
├── package.json
├── tsconfig.json
├── providers/                         # Compiled JS (referenced by plugin.json)
│   ├── oauth-auth.js                  # Auth provider
│   ├── ldap-user.js                   # User identity provider
│   ├── ldap-directory.js              # User directory provider
│   ├── npm-registry.js                # Integration registry provider
│   └── agent-registry.js              # Agent registry provider
└── src/providers/                     # TypeScript sources
    ├── oauth-auth.ts
    ├── ldap-user.ts
    ├── ldap-directory.ts
    ├── npm-registry.ts
    └── agent-registry.ts
```

## Usage as a Dependency

Other plugins reference this in their `plugin.json`:

```json
{
  "dependencies": [
    { "id": "shared-providers", "source": "../shared-providers" }
  ]
}
```

Station installs the dependency first through the same content-lock, consent,
provenance, and rollback lifecycle as a direct plugin. Its checked-in JavaScript
modules are the executable assets; the manifest cannot run a host build command.
`providers.register` remains inactive until the host-owned trusted-permission
review approves it.
