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
a value-free summary that clients can read, three
[capability switches](#capability-switches) in `limits` (`telemetry`,
`webhookAutomations` and `registries`), and the [engine limit](#engines)
`limits.engines`. It does **not** yet enforce any setting or any other limit. A policy that contains a setting entry or another limit
key is refused with "not supported by this version of Station". Station never
accepts a key it does not yet enforce, so a machine never looks managed when it
is not.

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
| `limits` | no | Only the [capability switches](#capability-switches) and [`engines`](#engines) in this release. |

Station refuses any other key, at any level. An unknown key may be a
restriction from a newer release, and Station will not run while it cannot
enforce one.

Do not put credentials in the policy. Every user on the machine can read it.

## Capability switches

Each switch can only turn something off. `false` restricts; any other value,
`true` included, is refused when Station starts, because a policy can never
force a capability on. Leave a key out to leave that capability to each user.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://help.example.com/station",
  "limits": {
    "telemetry": false,
    "webhookAutomations": false,
    "registries": {
      "allowedUrls": ["https://plugins.example.com/registry.json"],
      "unsignedPackages": false,
      "defaultSkillRegistries": false,
      "acpRegistryInstalls": false
    }
  }
}
```

| Key | What `false` (or the list) does |
| --- | --- |
| `limits.telemetry` | No usage sharing and no OpenTelemetry export from Station, whatever `telemetryTier`, `telemetryEnabled`, the telemetry endpoints, the environment variables or Do Not Track say. Station sends no daily count, notice or feedback to Kontour or to a configured product receiver. It registers no OpenTelemetry exporter, and the agent framework it embeds does not export traces or logs to its vendor service, even with `VOLTAGENT_PUBLIC_KEY` and `VOLTAGENT_SECRET_KEY` set. Connection checks and any change that raises a sharing choice are refused. See [what `limits.telemetry` does not cover](#what-limitstelemetry-does-not-cover). |
| `limits.webhookAutomations` | `POST /api/webhooks/inbound` refuses every request, a correctly signed one included, before it reads the webhook file. The file and its tokens are kept, and you can still edit or delete them, but nothing in the file (`enabled: true`, a new token) makes them run. |
| `limits.registries.allowedUrls` | Plugins, skills and tool servers (MCP) come only from catalogs at these `https` URLs, plus Station's bundled catalogs. Station refuses to load a policy that lists an `http` URL, because a registry read over plain http can be altered in transit. Every other catalog, a local folder included, reads as disabled. It cannot be added, enabled, refreshed or installed from, and update checks never contact it. A plugin already installed from it is not updated either: the update check fetches nothing from its git origin and reports its updates as managed by policy. URLs compare as parsed addresses, so `https://example.com/r` does not allow `https://example.com/r.evil`. A redirect from a listed catalog is followed only to the same origin or to another listed URL, and it is checked before it is requested. An empty list allows only the bundled catalogs. At most 64 URLs. |
| `limits.registries.unsignedPackages` | A plugin from a registry must carry a signature from a key the machine's own `registryTrust` already trusts. The policy adds no keys: without a trust profile for the registry, the install is refused. When the registry's entry shows the package is unsigned, the install, its preview and each of its registry dependencies are refused before any package bytes are fetched. A signature can only be verified against the bytes it signs, so a signed package is fetched first and then checked. Skills and tool-server definitions cannot be signed, so none comes from a catalog other than Station's bundled ones. |
| `limits.registries.defaultSkillRegistries` | Station's built-in skill registries are not registered, as if `disableDefaultSkillRegistries` were set. |
| `limits.registries.acpRegistryInstalls` | Engines cannot be added from the public ACP registry. Station's own engine entries are unaffected. |

What the switches do not cover:

- Code that is already installed keeps running. A switch stops new
  acquisition, not existing plugins, skills or engines. Removing an installed
  plugin and turning a marketplace off are never refused, whatever the catalog.
- Installing a plugin or skill straight from a source (a Git URL or a folder),
  not through a marketplace, is not a registry acquisition, so
  `limits.registries` does not govern it.
- The telemetry settings themselves (`telemetryTier`, the endpoints and their
  key references) cannot be managed under `settings`. Use `limits.telemetry`
  to turn telemetry off.

Users see one sentence wherever a switch refuses something, for example
"Example Corp's policy manages usage sharing: it is turned off. For help, visit
https://help.example.com/station". Settings shows it instead of the sharing
choices, beside a refused marketplace and in the product and OpenTelemetry
delivery status, where the connection checks are disabled;
the Connections page shows it for webhooks, and `station telemetry status`
prints it. API refusals answer `403` with code
`managed-policy-capability-disabled`. A refused registry install also carries
`reason: "managed-signature-required"` when the signature requirement refused
it.

### What `limits.telemetry` does not cover

The switch covers usage sharing and OpenTelemetry export. These separate
paths keep their own settings:

- **The Kontour Console bridge.** With `STATION_CONSOLE_HUB_URL` or
  `STATION_CONSOLE_FILE_SINK` set, Station delivers session and run events to
  that Console hub or to workspace files. It is off unless configured.
- **Private usage storage.** A person's usage pages go to the operator's own
  telemetry companion only after that person's analytics custody is set up.
- **Engines Station runs.** An engine's own program (a coding agent's
  command-line tool, for example) follows its own telemetry settings and
  environment variables, not this policy, and may report to its own vendor.
  Turn that off in the engine's configuration.

## Engines

`limits.engines` says which engines may run on the machine and how the ones
Station launches are started.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://help.example.com/station",
  "limits": {
    "engines": {
      "allowed": ["claude", "codex", "station-agent"],
      "acpRegistryAgents": false,
      "instances": {
        "claude": {
          "locked": true,
          "binaryPath": "/opt/example/bin/claude",
          "launchArgs": ["--settings", "/opt/example/claude-settings.json"],
          "environment": {
            "ANTHROPIC_BASE_URL": "https://llm-gateway.example.com",
            "CLAUDE_CONFIG_DIR": "/opt/example/claude-config"
          }
        }
      }
    }
  }
}
```

| Key | Rules |
| --- | --- |
| `allowed` | The engines that may run: any of `claude`, `codex`, `muse`, `acp` (every ACP connection) and `station-agent` (Station's own agent). Leave it out to allow every engine. An engine a plugin adds is never on the list, so an allow list turns plugin engines off. |
| `acpRegistryAgents` | `false` stops ACP connections added from the public ACP registry from running and from being added. A custom ACP connection is still allowed while `acp` is. `true` is refused. |
| `instances.<engine>` | How every connection of `claude`, `codex`, `muse` or `acp` is launched. `station-agent` runs inside Station and has no launch to pin. |

Station refuses an unknown engine id, a repeated one, and an `instances`
entry for an engine `allowed` leaves out.

### An engine that is not allowed

An engine the policy does not allow is unavailable everywhere:

- Starting a chat on it, sending a turn to an existing chat on it, and setting
  up or adding a connection for it are refused with "Example Corp's policy
  manages which engines run on this computer: codex is not allowed." and the
  support link. Over HTTP that is a `403` with code
  `managed-policy-engine-refused`.
- Its existing chats are kept. They do not run while the policy is installed,
  and run again if it is removed.
- Its connection reads as disabled, and the engine pages mark it "Managed by
  Example Corp" and "Not allowed".

### Pinned launch fields

An `instances` entry pins up to three fields. It must pin at least one, and
`locked` is required.

| Field | Rules |
| --- | --- |
| `binaryPath` | The program to run, as an absolute path of at most 1024 characters. A bare name is refused: it would be looked up on a `PATH` each user controls, where a wrapper of their own could stand in for the engine. |
| `launchArgs` | Up to 64 arguments, each at most 4096 characters. |
| `environment` | Up to 64 variables, each value at most 32 KiB. `TMPDIR` and `STATION_*` names are refused: Station sets them for every engine. |

`locked: true` makes each pinned field the administrator's; `locked: false`
fills only what the user left unset:

| | `locked: true` | `locked: false` |
| --- | --- | --- |
| `binaryPath` | Always the program run. | Claude, Codex and Muse: used, because the user names no program. ACP: the connection's own command is used. |
| `launchArgs` | Claude, Codex and Muse: added after Station's own arguments. ACP: replace the connection's arguments. | Claude, Codex and Muse: added after Station's own arguments. ACP: used only when the connection has none. |
| `environment` | Each variable overrides every other value, and the connection's own environment, config folder (`configHome`) and **Connect through** proxy are not applied. | Each variable is set only where the launch does not already set it. |

The pins apply to every launch of the engine that runs it: chats, Claude's
model discovery, ACP availability probes and sign-in, and the OpenCode model
listing. Claude's version and sign-in checks run the pinned program. The
Connections page's installed check for Claude, Codex and Muse still looks the
program up by name, so with only the pinned program installed it can report
the engine as missing even though chats run. A Claude
launch that would not run the pinned program (for example because the path is
missing, so the Agent SDK would fall back to its bundled copy) is refused
rather than started. While an engine's entry is locked, a plugin cannot
replace Station's built-in adapter for it, because a plugin runtime would not
apply the pins.

Every user on the machine can read the policy, so do not put a credential in
`environment`. Clients never see the values: the summary names the pinned
fields and variable names only.

### What a locked launch closes, and what it does not

A locked entry with an absolute `binaryPath` and a pinned `environment`
takes the engine's launch away from the user: a wrapper earlier on `PATH`, a
connection's environment variables and config folder, a model proxy, and an
ACP connection's command and arguments no longer reach the engine. Under an
approval-mode ceiling, this is what keeps a user from launching the engine
with flags or configuration that skip its permission checks.

It does not reach inside the engine:

- The engine reads its own configuration in its default folder (for example
  `~/.claude` or `~/.codex`) unless you pin the folder: set `CLAUDE_CONFIG_DIR`
  or `CODEX_HOME` in `environment` to a folder users cannot write.
- The engine finds the programs it runs (Node for an npm-installed CLI, the
  tools an agent calls) on the `PATH` Station runs with. Pin `PATH` to control
  that.
- Station's own environment is the base every launch starts from, and a user
  who can change how Station itself starts can change it.
- Signing in to a Claude or Codex account runs the program by name, without
  the pinned arguments or environment. It runs no agent.

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
STATION_MANAGED_POLICY_INVALID: Station cannot use the managed policy at /etc/station/policy.json: it does not match the policy schema (limits.engines: this limit is not supported by this version of Station). Station will not start until an administrator fixes or removes it.
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
limits, including each capability switch and the registry allow list. For
`limits.engines` it returns the allowed engines, whether ACP registry agents
may run, and for each pinned engine whether it is locked, which fields are
pinned and the names of its pinned variables. It never returns a setting value
or a launch value.

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
