# Managed policy

A managed policy lets an organization's IT administrator control Station on
the machines it manages. You install one policy file on a machine. Every
Station server on that machine loads the policy when it starts, applies it to
every client that connects (desktop, browser and mobile), and refuses to start
if it cannot enforce it.

This guide covers what the current release supports. The
[decision record](../decisions/managed-policy.md) explains the design and the
precedence rules. Settings, the remaining limits, configuration profiles and
Group Policy arrive in later releases (#4517–#4524). This guide grows with
them.

## What this release supports

The current release supports the policy document, the file source, the
fail-closed startup check, `station policy check` and `station policy show`,
a value-free summary that clients can read, and one limit:
[network exposure](#network-exposure) (`limits.clients`). It does **not** yet
enforce any setting or any other limit. A policy that contains a setting entry
or another limit key is refused with "not supported by this version of
Station". Station never accepts
a key it does not yet enforce, so a machine never looks managed when it is not.

A valid policy today names the organization and an optional support link:

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://help.example.com/station"
}
```

| Key | Required | Rules |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1`. A newer number means you need a newer Station. |
| `organization` | yes | One line, 1–200 characters, no leading or trailing spaces. Users see "Managed by <organization>". |
| `supportUrl` | no | An `https` URL of at most 2048 characters, with no user name or password. |
| `settings` | no | Must be empty (`{}`) in this release. |
| `limits` | no | May hold only `clients` in this release. |
| `limits.clients` | no | A list of `"desktop"`, `"local-browser"` and `"remote"`. See [Network exposure](#network-exposure). |

Station refuses any other key, at any level. An unknown key may be a
restriction from a newer release, and Station will not run while it cannot
enforce one.

Do not put credentials in the policy. Every user on the machine can read it.

## Where to install it

| OS | Path |
| --- | --- |
| macOS | `/Library/Application Support/Station/policy.json` |
| Windows | `C:\Program Files\Station\policy.json` |
| Linux | `/etc/station/policy.json` |

Install a regular file, not a symbolic link. On macOS and Linux the file and
every folder above it must be owned by root and must not be writable by their
group or by other users. Station refuses to start otherwise and names the
offending path. The stock folders already qualify (on macOS, `/Library` is
root:wheel 0755 and `/Library/Application Support` is root:admin 0755), and a
`Station` folder and file created with `sudo` and the default umask do too:

```bash
sudo mkdir -p "/Library/Application Support/Station"
sudo install -m 0644 policy.json "/Library/Application Support/Station/policy.json"
```

Station checks owner and mode bits, not ACLs, so do not grant write access
through a macOS ACL. Keep the `Station` folder writable by root only: anyone
who can write it can delete the policy, and Station starts unmanaged when the
file is gone. `station policy check` applies the ownership rule only when you
pass it the system path itself, so run it there after installing.

On Windows, Station refuses a link at the path but does not yet check the
file's owner or ACL (#4524). Make sure only administrators can write the file
and its folder. Station reads these exact paths; it does not use environment
variables to find them.

If no file is at the path, there is no policy, and Station runs exactly as it
does without one.

## Rollout

1. Write the policy file and check it on any machine with the Station CLI:

   ```bash
   station policy check ./policy.json
   ```

   `check` works offline. It runs the same validation as server startup. It
   exits `0` and prints what the policy does and its fingerprint, or exits `1`
   and lists each problem. Add `--json` for a machine-readable report.

2. Deploy the file to the path for each OS with your device management tool.

3. Restart Station on each machine. A running server keeps the policy it
   loaded at startup until it restarts.

4. Confirm on a machine:

   ```bash
   station policy show
   ```

   `show` prints the installed policy, its fingerprint, and the fingerprint
   the running local server loaded. When they differ, it says a restart is
   needed. When the installed policy is invalid, it says so and exits `1`,
   because the next start would fail. It compares only with a server on the
   same machine; for a remote target it says the comparison was skipped.
   `--json` returns `installed`, `running` and `restartNeeded`.

The fingerprint is `sha256:` and the SHA-256 of the policy with its keys
sorted and whitespace removed. Reformatting the file does not change it.

## When Station refuses to start

If a policy is installed but Station cannot use it, the server exits before it
listens and writes one line that starts with `STATION_MANAGED_POLICY_INVALID`.
The line names the file and the reason, for example:

```text
STATION_MANAGED_POLICY_INVALID: Station cannot use the managed policy at /etc/station/policy.json: it does not match the policy schema (limits.telemetry: this limit is not supported by this version of Station). Station will not start until an administrator fixes or removes it.
```

Station refuses to start when:

- the file cannot be read, or the path is a directory or another non-file
  (such as a FIFO);
- the path is a symbolic link, even one whose target is missing;
- the file, or a folder above it, is not owned by root or is writable by its
  group or other users (macOS and Linux);
- the file is larger than 1 MiB;
- the file is not valid JSON;
- the document repeats a key name in the same object (`duplicate key
  <path>`), so a second `limits` cannot quietly replace the first;
- the document does not match the schema, including a wrong `schemaVersion`,
  an unknown key, a setting entry or a limit key;
- more than one policy source is installed (this matters once configuration
  profiles and Group Policy are supported).

The desktop app shows that the organization's policy cannot be used and does
not retry; restarting cannot fix it. `station start` prints the same line as
the last server error. Its process supervisor does not yet recognize the
refusal, so it retries a few times (about 30 seconds) before it gives up
(#4536).
Fix or remove the policy, then start Station again.

## What clients see

Authenticated clients can read `GET /api/settings/managed-policy`. It returns
`{ "state": "none" }`, or the source, the fingerprint and a summary: the
organization, the support link, the locked setting paths and the effective
limits. It never returns a setting value.

## Network exposure

`limits.clients` lists how clients may reach Station on the machine:

- `desktop`: the desktop app.
- `local-browser`: a browser on the same machine, signed in with a
  `station open` link.
- `remote`: anything off the machine, such as paired phones and computers,
  the relay, nearby (LAN) discovery and Tailscale Serve.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "limits": { "clients": ["desktop", "local-browser"] }
}
```

`remote` is the kind you can leave out. This release cannot keep the desktop
app or a local browser out, so a list without `desktop` or `local-browser` is
refused. A policy without `limits.clients`, or with `remote` in it, leaves
network access as it is.

Without `remote`:

- **Station listens only on this computer.** With `STATION_HOST` unset or
  set to `localhost`, it binds `127.0.0.1`. Station never hands the name
  `localhost` to the listener, because a hosts file or resolver could map it
  to another interface. With `STATION_HOST` set to anything other than a
  loopback address or `localhost`, Station does not start. `station start`
  defaults to `127.0.0.1` and refuses another `--host` or such a
  `STATION_HOST`. The UI development server (`npm run dev:ui`) refuses a
  `--host` that is not a loopback address. The desktop app already binds
  `127.0.0.1`.
- **Every other listener stays on this computer too.** Each listener Station
  opens later binds a loopback address and is checked against Tailscale
  Serve as it starts (see below). It serves nothing until that check passes,
  and a refused one closes every connection it accepted. That covers the MCP
  Apps frame origin, the browser egress proxy, SSH forwards, the isolated
  repair relay and the UI development server (`vite dev` and `vite
  preview`). The telemetry companion's ports are checked at every Start, and
  at Station's startup too, since a running companion outlives Station. On Linux the repair worker container reaches
  Station through Docker's bridge rather than loopback, so isolated repairs
  are refused there (`repair-network-local-only`).
- **Nothing new can pair.** Pairing codes, access requests, relay setup and
  invitations, personal access tokens and Tailscale Serve setup
  (`station environment offer --tailscale`) are refused. Nearby discovery
  stays off and cannot be turned on. **Pair device** in Settings, **Pair
  phone** in the header, **Connect another device** in Connections and in
  first-run setup, and **Control this Station from another device** under
  Add a computer are disabled and show the policy's message, with a **Get
  help** link when the policy has a support link.
- **Devices paired earlier are suspended, not revoked.** Their credentials,
  relay links and personal access tokens stop working, and they get no
  notifications. Paired devices lists each one as, for example,
  "Suspended by Example Corp’s policy", and Station logs at startup how many devices,
  relay links and tokens are suspended. Nothing is deleted or revoked, so
  **removing the policy re-enables every one of them** at the next start.
  The policy is not a way to cut off a lost or compromised device: revoke
  that device under Paired devices, before or after installing the policy.
  Station keeps no record of earlier runs, so it does not log when lifting
  the policy restores them.
- **Discord commands are refused.** The Discord integration connects out to
  Discord, but the messages it receives are commands from people elsewhere.
  Under the limit its gateway does not connect, and its status shows the
  policy's message. Its configuration is kept, and it reconnects once the
  policy allows remote clients.
- **Station refuses to start while it could be reached from elsewhere.** It
  does not start when the relay connector is configured
  (`STATION_BROKER_CONFIG_FILE`), or when a supervisor still holds a listener
  bound to another address (quit Station completely and start it again).

### Tailscale Serve

At startup Station asks Tailscale whether Tailscale Serve forwards to any of
its ports (the server, voice, consent and UI ports, and each listener opened
later as it starts). It does not start while a route does, and the error
names the port and the command that turns routes off (`tailscale serve
status` lists them, `tailscale serve reset` turns all of them off). A route
that names a host, such as `localhost`, counts, since the name can lead to
this server. Station does not change Tailscale's configuration itself.

Station asks only a Tailscale command it can trust, never whatever
`tailscale` comes first on `PATH`, since any user can put a program there:

| OS | Station runs | Requirement |
| --- | --- | --- |
| macOS | `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (Mac App Store or tailscale.com) | Owned by root and signed by Tailscale Inc. (team `W5364U7YZB`). |
| Linux | `tailscale` in `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/usr/local/sbin`, `/bin` or `/sbin` | The file and every folder above it owned by root and not writable by group or others. Distribution and Tailscale repository packages qualify. |
| Windows | `C:\Program Files\Tailscale\tailscale.exe` (Tailscale's installer) | Its owner and ACLs are not checked yet (#4524). |

Station runs it with a fixed, minimal environment. A Homebrew install on macOS
does not qualify: its files belong to the Homebrew user. Before each run
Station checks that the file is the one it verified (same file, size and
times, and on macOS the same code-signing manifest); if it changed, Station
checks it again in full, signature included, before it runs it.

The trusted command answers for the system's Tailscale daemon only. A second
`tailscaled`, such as a userspace one a user starts with its own socket,
could forward while the system daemon reports stopped. So Station does not
start while any `tailscaled` other than the system daemon is running, and
names it: on macOS, where the app runs its daemon as a system extension, any
`tailscaled`; on Linux, one that is not owned by root or not in a system bin
folder. Windows is not checked for this yet.

Station starts when the trusted command says Tailscale is not running or is
signed out, or when nothing on the machine looks like Tailscale: no trusted
command, no `tailscale` or `tailscaled` on `PATH`, no daemon socket, no
`/Applications/Tailscale.app` and no Tailscale process. If there are signs of
Tailscale but no trusted command, Station does not start, names what it found,
and says what to install or stop. On macOS that means installing Tailscale
from the Mac App Store or tailscale.com, or stopping it (Homebrew: `sudo brew
services stop tailscale`). On Linux, install Tailscale's package or run `sudo
systemctl stop tailscaled`. If Tailscale is installed but does not answer, or
answers in a way Station cannot read, Station does not start until Tailscale
is set up, stopped or removed.

Station checks only when each listener starts: a route added later, or one
Tailscale restores when it starts again, is not seen until the next start.
Devices still cannot pair or sign in through such a route.

### What the limit does not cover

- **Inbound webhooks.** `POST /api/webhooks/inbound` is authorized by its own
  HMAC secret and grant, not by device pairing. It needs some way in, such as
  a tunnel, to be reached from elsewhere. Turning webhooks off is a separate
  switch (#4521).
- **Port forwarding with other tools**, such as `ssh -L` or `ssh -R`, a
  reverse proxy or a tunnel service. They connect to Station from this
  computer, so Station sees them as local. Devices paired earlier stay
  suspended and nothing new can pair through them, but a person who has this
  computer's sign-in link or desktop credentials could still use them.
  Control those tools separately. A userspace `tailscaled` that a user
  runs under their own account is in the same group: Station refuses to
  start while one runs under that name, but a renamed copy, or any other
  forwarder, is not detected.

## What a managed policy does not do

- It is not a sandbox. It controls what Station does. Engine CLIs keep their
  own configuration, such as an engine's own managed settings.
- A local administrator can still remove the policy or replace Station.
- It governs only the servers on the machine where it is installed. A client
  that connects to another machine's server gets that machine's policy.
- It never grants authority. Station's own checks, and operator restrictions,
  can narrow it further; nothing widens it.

## Testing with an isolated instance

Contributors can inject a policy into an isolated instance with
`STATION_MANAGED_POLICY_TEST_FILE=<absolute path>`. It works only on a machine
with no installed policy, and is not held to the root-ownership rule, though
it must still be a regular file. If a policy is installed, Station refuses to start
instead of using the test file, so the variable cannot be used to escape an
administrator's policy. See the
[decision record](../decisions/managed-policy.md#test-only-injection).
