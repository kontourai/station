# Design: SSH-launched Environments

> Implementation contract for the [native SSH launcher](../../src-desktop/src/ssh_launcher.rs), originating in archive#2577. Source and unit evidence are separate from qualification on a real remote host.

## The gap

The native SSH launcher starts or reuses a remote Station, owns its port forward, and then uses the normal pairing exchange. This lets an operator add an SSH target without manually starting Station first, while retaining the remote Git/Node prerequisites and explicit pairing boundary below.

## The trust question first, because it is the differentiator

A launched environment is code WE started on a machine, which is a stronger claim than "a Station we found." The design must not let launch smuggle trust:

1. **Launch and pairing stay separate acts.** The SSH flow ends by producing a pairing offer exactly as if the remote had run `station environment offer` itself. The desktop then pairs through the normal exchange — same credential issuance, same device record, same revocation. No SSH-derived bearer shortcuts.
2. **The launched server proves its identity before first use.** The launcher records the remote build's provenance (sha, channel, `system-status` route output) into the environment record at creation. A later connect that reports a different install path or downgraded sha surfaces as a warning, not silently.
3. **SSH credentials never enter the browser surface.** Launch is a desktop (Tauri) capability; the webview sees only the resulting environment. Same boundary the native credential store established in #2298.

## Mechanics

v1 launches a pinned source checkout. The published CLI is intentionally a
client and does not ship the host lifecycle needed to start a remote Station,
so an exact pinned `npx @kontourai/station-cli@<version>` invocation cannot
replace the checkout path.

1. The Tauri host runs non-interactive OpenSSH with argument arrays and validated targets. `ssh <target> true` must succeed or the flow stops with SSH's error verbatim. It then requires remote `git --version` and a `node --version` satisfying this checkout's build-time `package.json#engines.node`; v1 does not install either prerequisite.
2. The expected revision is the connected desktop Station's own full `buildSha` from `GET /api/system/instance`. Absence stops the flow; a mutable ref is never substituted. The remote clones this repository into `~/.station/ssh-launch/checkout`, or fetches when that Git checkout exists, then runs `git checkout --detach <sha>`. `git rev-parse HEAD` must byte-match the expected SHA before installation or execution proceeds. Clone and fetch use the remote user's existing Git authentication and return Git's failure output verbatim.
3. Before installation, the launcher probes `http://127.0.0.1:<remote-port>/.well-known/station/v1` over SSH. A live server is reused and that fact is recorded. Otherwise it runs `npm --prefix <verified-checkout> run dependencies:ci` (the pinned pnpm and reviewed lifecycle entry), then starts `STATION_HOST=127.0.0.1 ./station start --instance=ssh-launched --port=<remote-port>` from the verified checkout. Because checkout, install, and build can be slow, Tauri returns a launch id immediately; the UI polls status through `probing`, `cloning`, `installing`, `starting`, and `ready` or `failed`. Failure includes the failing step's bounded stderr tail.
4. Tauri owns a child `ssh -L <local-port>:127.0.0.1:<remote-port> -N <target>`. The resulting environment endpoint records `transport: ssh-forward`; an exited forward is reported as `launcher closed`, not inferred to mean the host is offline.
5. The final remote command is `./station environment offer`. Its offer crosses the forward and the desktop completes the normal pairing exchange. SSH does not mint or carry a Station bearer, and SSH credentials remain outside the webview.
6. At environment creation the desktop records `{ sha, channel: 'source-checkout', capturedAt }`. A reused server's full SHA is verified after pairing through the authenticated status surface. A reconnect whose reported SHA differs from the pinned expectation retains the environment but derives a visible provenance warning; it never silently rewrites the expectation.

## Non-goals (v1)

Windows remotes; password/keyboard-interactive auth; remote Git or Node
installation; remote upgrades; multiple simultaneous forwards to one host; or
expanding the published client CLI into a host distribution.

## Acceptance sketch

- Add environment → SSH target → probe/launch/pair → environment appears in the standard list with provenance recorded.
- Kill the desktop: forward dies; reconnect flow restarts it without re-launch when the remote server survived.
- A tampered remote (different sha at reconnect) surfaces the mismatch before any session is dispatched to it.
