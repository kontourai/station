# Contribute to Station

Use the [repository contribution guide](https://github.com/kontourai/station/blob/main/CONTRIBUTING.md)
for the current contribution paths, review expectations, and verification
authority. This public guide is intentionally a short orientation, not a copy
of repository operations or delivery state.

## Contributor commands

The optional `just` interface is available on macOS, Linux, and Windows.
Install Just 1.44.0 or later with `brew install just` on macOS, `cargo install just --locked` on Linux when a package-manager install is unavailable, or `winget install --id Casey.Just --exact` in Windows Command Prompt. Confirm it with `just --version`.

Use Unix shell quotes for forwarded values, for example `just test 'name with spaces'`. In Windows Command Prompt use double quotes: `just test "name with spaces"`. The [generated contributor command reference](../reference/contributor-commands.md)
lists every supported recipe and its platform-specific command form.

The recipes are conveniences. The repository guide names the canonical command
and completion evidence for a contribution; a convenience command never creates
a second receipt protocol.

## Keep public contributions safe

Do not include secrets, access tokens, private URLs, customer data, or
unredacted diagnostics in public reports. Use the repository's security route
for suspected vulnerabilities. If AI tools assisted a change, disclose the
tools and affected areas in the contribution while personally inspecting the
submitted result.
