# Design: SSH-launched Environments

> **Reading status: retained native launcher with a replaced UI composition.**
> The [native SSH launcher](../../src-desktop/src/ssh_launcher.rs) and
> [Tauri adapter](../../src-ui/src/platform/native/sshLauncher.ts) remain, but
> the current Add computer flow uses the server-owned
> [SSH computer creator](../../src-ui/src/views/connections-hub/SshComputerCreatorDialog.tsx).
> It does not call the native launcher. Existing saved-forward rows still
> [read launch status and show provenance warnings](../../src-ui/src/views/connections-hub/ComputersSection.tsx).
> This record originated in archive#2577; its acceptance journey is historical,
> not a currently mounted end-to-end flow or a fresh remote-host qualification.

## The gap

When invoked, the native SSH launcher starts or reuses a remote Station, owns
its port forward, and returns a pairing offer. Completing pairing and saving
the resulting connection requires a caller. The current SSH creator instead
saves a server-owned environment profile after a reachability probe; see
[machine relationships](../guides/machine-relationships.md) for that journey.

## The trust question first, because it is the differentiator

A launched environment is code WE started on a machine, which is a stronger claim than "a Station we found." The design must not let launch smuggle trust:

1. **Launch and pairing stay separate acts.** The SSH flow ends by producing a pairing offer exactly as if the remote had run `station environment offer` itself. The desktop then pairs through the normal exchange — same credential issuance, same device record, same revocation. No SSH-derived bearer shortcuts.
2. **Checkout identity and running-server identity are separate.** The native launcher verifies the requested checkout SHA. Its discovery probe can reuse a running server and does not authenticate that server's build SHA. A caller must pair and check the authenticated server identity. Existing saved-forward rows compare recorded and reported SHA; they do not compare install paths or establish that one SHA is a downgrade.
3. **SSH credentials never enter the browser surface.** Launch is a desktop (Tauri) capability; the webview sees only the resulting environment. Same boundary the native credential store established in #2298.

## Mechanics

v1 launches a pinned source checkout. The published CLI is intentionally a
client and does not ship the host lifecycle needed to start a remote Station,
so an exact pinned `npx @kontourai/station-cli@<version>` invocation cannot
replace the checkout path.

1. The Tauri host runs non-interactive OpenSSH with argument arrays and validated targets. `ssh <target> true` must succeed or the flow stops with SSH's error verbatim. It then requires remote `git --version` and a `node --version` satisfying this checkout's build-time `package.json#engines.node`; v1 does not install either prerequisite.
2. The native request requires an explicit full SHA. The original UI contract selected the connected desktop Station's `buildSha` from `GET /api/system/instance`; that creation caller is no longer mounted. The remote clones this repository into `~/.station/ssh-launch/checkout`, or fetches when that Git checkout exists, then runs `git checkout --detach <sha>`. `git rev-parse HEAD` must byte-match the expected SHA before installation or execution proceeds. Clone and fetch use the remote user's existing Git authentication. Their failures stop the launch and contribute command output to its error status.
3. Before installation, the launcher probes `http://127.0.0.1:<remote-port>/.well-known/station/v1` over SSH. A response with a nonempty `environmentId` is reused and that fact is recorded. Otherwise it runs `npm --prefix <verified-checkout> run dependencies:ci` (the pinned pnpm and reviewed lifecycle entry), then starts `STATION_HOST=127.0.0.1 ./station start --instance=ssh-launched --port=<remote-port> --ui-port=<remote-port+10>` from the verified checkout. Tauri returns a launch id immediately; the status API exposes `probing`, `cloning`, `installing`, `starting`, and `ready` or `failed`. Failure includes the failing step's bounded stderr tail.
4. Tauri owns a child `ssh -L <local-port>:127.0.0.1:<remote-port> -N <target>`. The resulting environment endpoint records `transport: ssh-forward`; an exited forward is reported as `launcher closed`, not inferred to mean the host is offline.
5. The final remote command is `./station environment offer --payload-only --advertise-url <local-forward-url>`. The returned offer is exposed through launch status for a caller to complete normal pairing. SSH does not mint a Station bearer, and SSH credentials remain outside the webview.
6. Saved-forward connection records can retain `{ sha, channel, capturedAt }` provenance. Their current row compares the recorded SHA with the authenticated status response, retains the connection on mismatch, and shows a warning. That display does not restore the removed creation/pairing caller or block all session dispatch.

## Non-goals (v1)

Windows remotes; password/keyboard-interactive auth; remote Git or Node
installation; remote upgrades; multiple simultaneous forwards to one host; or
expanding the published client CLI into a host distribution.

## Acceptance sketch

These were the original end-to-end acceptance goals. The retained native
module and existing-forward display do not by themselves meet them today.

- Add environment → SSH target → probe/launch/pair → environment appears in the standard list with provenance recorded.
- Kill the desktop: forward dies; reconnect flow restarts it without re-launch when the remote server survived.
- A tampered remote (different sha at reconnect) surfaces the mismatch before any session is dispatched to it.
