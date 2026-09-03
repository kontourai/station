# Shared Providers Example

A headless plugin (no UI) that contributes shared infrastructure providers — auth, user identity, user directory, and registries. Other plugins declare this as a dependency to inherit these capabilities.

## Patterns Demonstrated

### Provider-Only Plugin
This plugin has no `entrypoint`, `layout`, or `agents`. It exists solely to contribute providers that other plugins consume. The `providers` array in `plugin.json` maps provider types to JS modules.

### Settings Schema
`plugin.json` declares typed settings (`text`, `boolean`, `select`) that appear in the Station settings UI. Providers read these at runtime via `process.env` or the settings API.

### Auth Provider (`oauth-auth`)
Implements the full auth lifecycle: status check (valid/expiring/expired/missing), interactive renewal config, and prerequisite detection. Replace the token path and CLI commands with your organization's SSO tooling.

### User Identity Provider (`ldap-user`)
Returns the current user's identity from the OS, then enriches it by calling an MCP tool to look up additional details (name, title, email) from a directory service.

### User Directory Provider (`ldap-directory`)
Provides `lookupPerson` and `searchPeople` for the people-picker UI. Finds an agent with the right MCP server attached and calls its tools.

### Integration Registry Provider (`npm-registry`)
Discovers and installs MCP servers from an npm-compatible registry. Manages `tool.json` definitions in the Station tools directory.

### Agent Registry Provider (`agent-registry`)
Lists agent packages from a CLI tool. Install/uninstall are delegated to the CLI itself.

### External Links
The `links` array in `plugin.json` adds navigation items to the Station UI (e.g., an admin dashboard link).

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
