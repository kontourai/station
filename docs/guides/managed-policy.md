# Managed policy

A managed policy lets an organization's IT administrator control Station on
the machines it manages. You install one policy on a machine: a file, a macOS
configuration profile, or Windows Group Policy (or Intune). Every
Station server on that machine loads the policy when it starts, applies it to
every client that connects (desktop, browser and mobile), and refuses to start
if it cannot enforce it.

This guide covers what the current release supports. The
[decision record](../decisions/managed-policy.md) explains the design and the
precedence rules. Settings and the other limits arrive in later releases
(#4517–#4522). This guide grows with them.

## What this release supports

The current release supports the policy document, three ways to install it
(the [file](#where-to-install-it), a
[macOS configuration profile](#deploy-with-a-macos-configuration-profile) and
[Group Policy or Intune](#deploy-with-group-policy-or-intune) on Windows), the
fail-closed startup check, `station policy check`, `station policy show` and
`station policy templates`,
a value-free summary that clients can read, and three
[capability switches](#capability-switches) in `limits`: `telemetry`,
`webhookAutomations` and `registries`. It does **not** yet enforce any setting
or any other limit. A policy that contains a setting entry or another limit
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
| `limits` | no | Only the [capability switches](#capability-switches) in this release. |

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

On Windows, the file, `C:\Program Files\Station` and every folder above it
must be owned by Administrators, SYSTEM or TrustedInstaller, and no one else
may be granted a right that changes them. For the file and its folder that is
any write right. For `C:\Program Files` and `C:\` it is the rights that
could remove or re-permission what is below (delete, delete a child, change
permissions or owner), so the stock "create folders" right that Authenticated
Users have on `C:\` is fine. A folder created in `C:\Program Files` from an
elevated prompt inherits a qualifying ACL:

```powershell
New-Item -ItemType Directory -Force 'C:\Program Files\Station'
Copy-Item .\policy.json 'C:\Program Files\Station\policy.json'
```

Station reads the owner and access list through the Windows API, refuses a
symbolic link, junction or other reparse point anywhere in the path, and fails
closed when it cannot read them. Station reads these exact paths; it does not
use environment variables to find them.

If no file is at the path, there is no policy, and Station runs exactly as it
does without one.

## Deploy with a macOS configuration profile

Deploy the policy as a configuration profile with **System** scope for the
preference domain `io.kontourai.station`. macOS installs it as
`/Library/Managed Preferences/io.kontourai.station.plist`, and Station reads
that file. Station ignores user-scoped profiles, which land under
`/Library/Managed Preferences/<user>/`.

Generate a complete profile from a checked policy:

```bash
station policy templates ./out --policy ./policy.json
```

`out/macos/station.mobileconfig` has one payload of type
`io.kontourai.station` that carries the policy's keys. Upload it to your MDM
as a custom profile, or sign it and install it directly. Its identifiers are
fixed, so a profile generated from a changed policy replaces the installed
one. Station also reads the `Forced` / `mcx_preference_settings` form that an
MDM's "custom settings" screen writes for a
`com.apple.ManagedClient.preferences` payload.

Station checks the installed plist like a policy file (a regular file owned by
root, in folders only root can write) and converts it with `/usr/bin/plutil`,
called by its full path. The keys and rules are the same as the file's. The
property-list format has two limits:

- There is no `null` in a property list. A policy that uses `null` cannot be a
  profile; `station policy templates` refuses it and names the key. Deploy
  that policy as a file.
- A `<date>` or `<data>` value is refused when Station starts; no policy key
  takes one.
- A key repeated in one `<dict>` of an XML profile is refused, as in a file.
  A property list otherwise keeps the last of the two.

Profile metadata that macOS writes beside the keys (`PayloadUUID`,
`PayloadIdentifier`, `PayloadType`, `PayloadVersion`, `PayloadDisplayName`,
`PayloadDescription`, `PayloadOrganization`, `PayloadEnabled`,
`_manualProfile`) is ignored. Any other key is refused like an unknown key in
a file.

A profile and a policy file on the same Mac is a startup error: remove one.
After the profile installs, run `station policy show`; it names the profile as
the installed source.

## Deploy with Group Policy or Intune

On Windows, Station reads `HKLM\SOFTWARE\Policies\Kontour\Station` through
the Windows API in its own process, not through `reg.exe` or PowerShell, so
blocking those tools for users does not matter. It reads only that machine
key. It never reads `HKEY_CURRENT_USER` or any other place a user can write.
`HKLM\SOFTWARE\Policies` is shared by the 32-bit and 64-bit registry views,
so a 32-bit tool writes the same key. WSL runs Linux, so Station inside WSL
reads `/etc/station/policy.json` in that distribution, not the Windows
registry.

The key holds the policy one of two ways, never both:

- **The Group Policy template.** One value per setting, written by the ADMX
  template below.
- **One `Policy` value.** A `REG_SZ` holding the whole policy as JSON, exactly
  as the file would hold it.

The key, and every key above it up to `HKLM\SOFTWARE`, must be owned by
Administrators, SYSTEM or TrustedInstaller and changeable by no one else. Keys
that Group Policy, Intune or an elevated prompt creates under
`HKLM\SOFTWARE\Policies` inherit such an ACL.

### Install the template

```bash
station policy templates ./out
```

Copy `out/windows/station.admx` to `PolicyDefinitions` and
`out/windows/en-US/station.adml` to `PolicyDefinitions\en-US`:

- for one machine, `C:\Windows\PolicyDefinitions`;
- for a domain, the central store,
  `\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions`.

The settings appear under **Computer Configuration > Administrative Templates
> Station**. Configure them in a Group Policy object, then on a client run
`gpupdate /target:computer /force` and restart Station (a running server keeps
the policy it loaded at startup). `station policy show` confirms what is
installed and loaded.

**Intune:** import `station.admx` and `station.adml` under **Devices >
Configuration > Import ADMX**. Intune first needs the templates the file
depends on; this one depends on none. Then create a profile from the
imported templates and assign it to devices.

### What each setting writes

Every value is in `HKLM\SOFTWARE\Policies\Kontour\Station`.

| Setting | Values | Policy document |
| --- | --- | --- |
| Organization | `Organization` (`REG_SZ`), `SupportUrl` (`REG_SZ`, blank for none) | `organization`, `supportUrl` |
| Managed settings (JSON) | `ManagedSettings` (`REG_DWORD` state), `ManagedSettingsJson` (`REG_MULTI_SZ`, lines joined) | `settings` (must be `{}` in this release) |
| Allow usage data and telemetry | `Telemetry` (`REG_DWORD`) | `limits.telemetry: false` when Disabled |
| Allow webhook automations | `WebhookAutomations` (`REG_DWORD`) | `limits.webhookAutomations: false` when Disabled |
| Allowed plugin and skill registries | `RegistryAllowList` (`REG_DWORD` state), `RegistryAllowedUrls` (`REG_MULTI_SZ`, one URL per line) | `limits.registries.allowedUrls` |
| Allow unsigned registry packages | `RegistryUnsignedPackages` (`REG_DWORD`) | `limits.registries.unsignedPackages: false` when Disabled |
| Allow the default skill registries | `DefaultSkillRegistries` (`REG_DWORD`) | `limits.registries.defaultSkillRegistries: false` when Disabled |
| Allow engine installs from the ACP registry | `AcpRegistryInstalls` (`REG_DWORD`) | `limits.registries.acpRegistryInstalls: false` when Disabled |

The template carries a setting for every limit this release enforces. Later
limits join it when they ship.

### What Enabled, Disabled and Not Configured mean

| Kind of setting | Enabled | Disabled | Not Configured |
| --- | --- | --- | --- |
| An **Allow …** switch | Leaves it to each user, like Not Configured (writes `1`) | Turns the capability off (writes `0`) | No value |
| Any other setting | Applies its value (state value `1`) | **Startup error.** Station will not start (state value `0`). | No value |
| Organization | Required whenever any other setting is configured | Its text is removed; with any other setting configured, that is a startup error | No value |

Disabled never means "no restriction". An administrator who disables
"Allowed plugin and skill registries" did not ask for every registry, so
Station refuses to start and says which setting is Disabled. Use Not
Configured to remove a restriction.

Station also refuses to start when the key holds a value or subkey the
template does not define (it may be a setting from a newer template), a value
of the wrong type, a `REG_DWORD` other than `0` or `1`, or both a `Policy`
value and template values. An empty key is no policy.

### The single `Policy` value

To deploy the JSON document unchanged, for example from a script, write it as
one `REG_SZ` from an elevated PowerShell prompt:

```powershell
$key = 'HKLM:\SOFTWARE\Policies\Kontour\Station'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name Policy -PropertyType String -Force `
  -Value (Get-Content -Raw .\policy.json)
```

Run `station policy check .\policy.json` first. With Intune, use a
PowerShell script or a custom OMA-URI setting that writes the same value.

A registry policy and `C:\Program Files\Station\policy.json` on the same
machine is a startup error: remove one.

## Rollout

1. Write the policy file and check it on any machine with the Station CLI:

   ```bash
   station policy check ./policy.json
   ```

   `check` works offline. It runs the same validation as server startup. It
   exits `0` and prints what the policy does and its fingerprint, or exits `1`
   and lists each problem. Add `--json` for a machine-readable report.

2. Deploy it with your device management tool: the file at the path for each
   OS, a configuration profile on macOS, or Group Policy or Intune on Windows.

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
- on Windows, the file, a folder above it, or the policy registry key or a
  key above it, has another owner than Administrators, SYSTEM or
  TrustedInstaller, grants someone else a right to change it, or is a reparse
  point;
- the Windows registry or a configuration profile cannot be read, or the
  registry key holds something the template does not define, a Disabled
  setting that is not an **Allow …** switch, or both a `Policy` value and
  template values;
- the file is larger than 1 MiB;
- the file is not valid JSON;
- the document repeats a key name in the same object (`duplicate key
  <path>`), so a second `limits` cannot quietly replace the first;
- the document does not match the schema, including a wrong `schemaVersion`,
  an unknown key, a setting entry or a limit key;
- more than one policy source is installed: a file and a configuration
  profile, or a file and the registry key.

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
limits, including each capability switch and the registry allow list. It never
returns a setting value.

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
