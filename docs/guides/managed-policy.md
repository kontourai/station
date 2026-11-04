# Managed policy

A managed policy lets an organization's IT administrator control Station on
the machines it manages. You install one policy file on a machine. Every
Station server on that machine loads the policy when it starts, applies it to
every client that connects (desktop, browser and mobile), and refuses to start
if it cannot enforce it.

This guide covers what the current release supports. The
[decision record](../decisions/managed-policy.md) explains the design and the
precedence rules. Settings, the other limits, configuration profiles and Group
Policy arrive in later releases (#4517–#4524). This guide grows with them.

## What this release supports

The current release supports the policy document, the file source, the
fail-closed startup check, `station policy check` and `station policy show`,
a value-free summary that clients can read, and one limit:
[update control](#update-control) (`limits.updates`). It does **not** yet
enforce any setting or other limit. A policy that contains a setting entry or
another limit key is refused with "not supported by this version of Station".
Station never accepts a key it does not yet enforce, so a machine never looks
managed when it is not.

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
| `limits` | no | May contain only `updates` in this release; see [update control](#update-control). |

Station refuses any other key, at any level. An unknown key may be a
restriction from a newer release, and Station will not run while it cannot
enforce one.

Do not put credentials in the policy. Every user on the machine can read it.

## Update control

`limits.updates` controls how Station on the machine updates itself:

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "limits": {
    "updates": {
      "mode": "auto",
      "feedUrl": "https://mirror.example.com/station/",
      "allowNightly": false
    }
  }
}
```

| Key | Default | Rules |
| --- | --- | --- |
| `mode` | `"auto"` | `"off"` stops every update check, download and install. |
| `feedUrl` | none | An `https` URL of at most 2048 characters, in canonical form (lowercase host, no `..`), with no user name, password, query or fragment. Updates come only from this mirror. |
| `allowNightly` | `true` | `false` makes the nightly channel unavailable: a nightly install, desktop app or server does not update. |

Every key is optional; `"updates": {}` changes nothing. Any other key inside
`updates` is refused.

### What each surface does

| Surface | `mode: "off"` or nightly not allowed | `feedUrl` |
| --- | --- | --- |
| Desktop app updater | Never checks, downloads or installs. The update panel shows updates as unavailable, with the policy's sentence under the check error's technical details; clearer wording is a follow-up. | Checks the mirror's copy of the app's channel feed and refuses an update whose download is outside the mirror. |
| Server update (`/api/system/core-update` and the server's own background check and download) | The check contacts nothing and reports the policy; download, apply and update when idle are refused (403). | A prebuilt archive checks the mirror's copy of its ring's signed manifest. A desktop bundle's or source checkout's server update is refused, because it compares against a git remote the mirror does not serve; the desktop app updates a desktop bundle from the mirror. |
| `station upgrade` | Refused before anything changes, and exits `1`. | A packaged install runs its installer against the mirror. A source checkout is refused. |
| The Station service's own update (the launcher's download and apply steps) | Every request is refused before anything downloads or restarts, including applying a version that was downloaded before the policy was installed. Under `allowNightly: false`, a nightly-numbered version counts as nightly whatever ring the install records, and an install whose recorded state names no ring, or a ring this build does not ship, is refused. | The installer reads the mirror's manifest and downloads every archive from the mirror. |

`limits.updates` governs these four, Station's own update paths. Running
`install.sh` or `install.ps1` by hand is replacing Station, not updating it,
and the policy does not govern it: a policy cannot stop a user from replacing
Station, and application controls are the tool for that. `install.sh` follows
a mirror only when `STATION_INSTALL_MIRROR_URL` is set, which `station upgrade`
and the service's update step do under a `feedUrl`; run by hand without it, it
downloads from the default location.

The desktop app reads the policy itself when it starts, not from the server, so
the updater obeys the policy even when the bundled server cannot start, and
even when the server refuses to start because of the policy. If the desktop app
cannot use the installed policy file (for example it is not valid JSON, it is
not owned by root, or `limits.updates` contains a value it does not
understand), it turns updates off rather than guess. If only another part of
the policy is something this version cannot enforce, the server refuses to
start but the desktop app still applies `limits.updates`, so an approved
mirror can deliver the version that understands the rest.

The server and the desktop app read the policy when they start; restart them
after changing it. `station upgrade` and the service's update step read it
each time they run. An installed policy Station cannot use refuses
`station upgrade` the same way it refuses server startup.

Not yet supported: on Windows, the installer cannot download from a mirror, so
with a `feedUrl` set `station upgrade` and the service's update step are
refused there. The desktop app's mirror support works on every desktop
platform.

### Mirror layout

A mirror reproduces Station's release download tree. Every file Station
updates from is published at
`https://github.com/kontourai/station/releases/download/<release tag>/<file>`,
and Station fetches the same `<release tag>/<file>` under the mirror instead.
With `"feedUrl": "https://mirror.example.com/station/"`:

| Surface | Fetched from the mirror |
| --- | --- |
| Desktop app | `<channel>-desktop/latest.json` (for example `stable-desktop/latest.json`): the path of the endpoint the app was built with. Rewrite each `platforms.*.url` in it to the mirror's copy of the update archive; Station refuses a download whose URL is not under `feedUrl`. The archives keep their signatures, so rewriting the URLs does not need a new signature. |
| Prebuilt server archive (check, `station upgrade`, the service's update) | `portable-<ring>/station-portable-<ring>-manifest.json`, where the ring is `stable`, `preview` or `nightly`; then `<tag>/<archive>` for every archive the signed manifest names (for example `v1.2.3/station-server-linux-x64.tar.gz`). Serve the manifest unchanged: it is signed, and its archive size and SHA-256 still bind the bytes the mirror serves. |

Serve every file directly from the mirror's own origin. Under a mirror,
Station follows a redirect for a feed, manifest or archive only when it stays
on the same scheme, host and port as `feedUrl`, at most five times; a redirect
anywhere else, including a CDN or object storage on another host, is refused.
This applies to the server's check, `install.sh` under
`STATION_INSTALL_MIRROR_URL`, and the desktop updater. `install.sh` also
refuses a redirect `Location`, or a download URL, that is not plain ASCII
text: a backslash, a user name, whitespace or control characters, or `@` or
`%` in the host part. It then downloads only the canonical form of the URL it
checked. Without a mirror,
Station follows the redirects GitHub serves release assets through, as before.

The installer also refuses to download Node.js under a mirror. The service's
update step uses the Node.js the installed version bundles; if you run
`station upgrade` on a machine without Node.js 24 on the `PATH`, install it
first.

`feedUrl` may contain an access token in its path. Clients never see it: the
summary reports only `"mirror": true`. It is still readable by every user on
the machine, like the rest of the policy, and a packaged install records the
mirror's manifest URL in its own install state after an update. The desktop
app removes the path from every URL in an update error before it shows or
logs it, keeping only the scheme, host and port, and it drops the updater
plugin's own log records, which contain request URLs.

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
  an unknown key, a setting entry or a limit key other than `updates`;
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
limits. It never returns a setting value or the update feed URL; for
`limits.updates` it returns `mode`, `allowNightly` and whether a mirror is set.

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
