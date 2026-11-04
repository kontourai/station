# Managed policy

A managed policy lets an organization's IT administrator control Station on
the machines it manages. You install one policy file on a machine. Every
Station server on that machine loads the policy when it starts, applies it to
every client that connects (desktop, browser and mobile), and refuses to start
if it cannot enforce it.

This guide covers what the current release supports. The
[decision record](../decisions/managed-policy.md) explains the design and the
precedence rules. Limits, configuration profiles and Group Policy arrive in
later releases (#4518–#4524). This guide grows with them.

## What this release supports

The current release supports the policy document, the file source, the
fail-closed startup check, `station policy check` and `station policy show`,
a value-free summary that clients can read, and
[managed settings](#settings): defaults and fixed values for Station settings.
It does **not** yet enforce any limit. A policy that contains a limit key is
refused with "not supported by this version of Station". Station never accepts
a key it does not yet enforce, so a machine never looks managed when it is not.

A valid policy names the organization and an optional support link, and can
manage settings:

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://help.example.com/station",
  "settings": {
    "defaultMaxTurns": { "value": 40, "locked": true },
    "checkoutStaleAfterDays": { "value": 9, "locked": false }
  }
}
```

| Key | Required | Rules |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1`. A newer number means you need a newer Station. |
| `organization` | yes | One line, 1–200 characters, no leading or trailing spaces. Users see "Managed by <organization>". |
| `supportUrl` | no | An `https` URL of at most 2048 characters, with no user name or password. |
| `settings` | no | Managed settings, keyed by setting. See [Settings](#settings). |
| `limits` | no | Must be empty (`{}`) in this release. |

Station refuses any other key, at any level. An unknown key may be a
restriction from a newer release, and Station will not run while it cannot
enforce one.

Do not put credentials in the policy. Every user on the machine can read it.

## Settings

Each key under `settings` is a Station setting key, the name `station config
get` and `station config set` use (for example `defaultMaxTurns`). Each entry
has exactly two keys:

- `"locked": true` fixes the value. Users, agents and the offline CLI cannot
  change it, in Settings or in a project's settings, and Settings shows the
  control as "Managed by <organization>", disabled, with a "Get help" link to
  your `supportUrl`. A lock also replaces a project's own choice for that
  setting.
- `"locked": false` sets a default. It applies only where the user has not
  chosen a value and no environment variable supplies one, and users can
  change it. Settings labels it "<organization> default". That includes the
  variables a setting's consumer reads itself: `STATION_LOG_LEVEL` for
  `logLevel`, and `SHELL` (or `COMSPEC` on Windows) for `terminalShell`, so a
  `terminalShell` default rarely applies where a login shell is set. A lock
  outranks all of them.

A lock also replaces a project's own choice of that setting, and of the
choices that go with it: locking `defaultModel` or `defaultLLMProvider` takes
the project's model, provider and "last used" model selection, and locking
`defaultApprovalMode` takes the project's approval default and its "last
used" selection. Project settings show those fields as unset while the lock
applies; saving a project with them unset keeps the project's own values for
when the policy is removed, and setting one is refused.

Station never writes these values into the user's configuration. Remove the
policy and restart, and every user's own values come back.

Station checks every entry when it starts and refuses the policy if:

- the key is not a Station setting, or names a field inside one
  (`approvalGuardian.enabled`): a setting is managed as a whole, so manage
  `approvalGuardian` with its complete value;
- the key is a device setting (such as `theme`): those are stored on each
  device, where the server cannot enforce them;
- the key is an environment variable (such as `AWS_REGION`): manage the
  setting that reads it (`region`) instead;
- the setting is internal, derived at runtime, or secret (the policy is
  readable by every user on the machine);
- the setting is a telemetry setting (`telemetryTier` and the product and
  OpenTelemetry endpoints and key references): Station reads those before it
  loads the policy and resolves them against environment variables, so it
  could not apply a managed value. Telemetry will be managed through limits
  (#4521);
- the value has the wrong type or is out of range, as a settings write would
  report it; is `null` for a setting that cannot store `null`; or is a blank
  string, which Station reads as unset;
- a structured value (such as `approvalGuardian`) does not match Station's
  settings schema. `station policy check` runs the same schema check as the
  server, which runs it before it starts listening.

`station policy check` prints one line per entry saying what it does. The
summary clients read lists the locked setting keys, never their values.

When a user, an agent or a script tries to change a locked setting, Station
refuses with "<organization>'s policy manages this setting." and the support
link. Over HTTP that is a `403` with `code: managed_setting_locked` and the
setting's `key`, from `PUT /config/app` and from project create and update
alike. Saving exactly the locked value from Settings, `PUT /config/app` or
`station config set` is accepted and stores nothing.

The offline CLI applies the installed policy too: `station config get
--offline` and `station registry` read the managed values, and refuse while
the installed policy is one Station would refuse at startup.

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
  an unknown key, a [settings entry Station cannot apply](#settings), or a
  limit key;
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
organization, the support link, the locked setting keys and the effective
limits. It never returns a setting value.

`GET /config/app` returns the values in effect, managed ones included, and its
per-setting provenance reports `{ "source": "managed", "locked": true | false,
"organization": …, "supportUrl": … }` for a value the policy supplied.
`station config get <key>` prints the same as a note.

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
