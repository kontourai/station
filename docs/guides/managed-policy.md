# Managed policy

A managed policy lets an organization's IT administrator control Station on
the machines it manages. You install one policy on a machine: a file, a macOS
configuration profile, or Windows Group Policy (or Intune). Every
Station server on that machine loads the policy when it starts, applies it to
every client that connects (desktop, browser and mobile), and refuses to start
if it cannot enforce it.

This guide covers what the current release supports. The
[decision record](../decisions/managed-policy.md) explains the design and the
precedence rules.

## What this release supports

The current release supports the policy document, three ways to install it
(the [file](#where-to-install-it), a
[macOS configuration profile](#deploy-with-a-macos-configuration-profile) and
[Group Policy or Intune](#deploy-with-group-policy-or-intune) on Windows), the
fail-closed startup check, `station policy check`, `station policy show` and
`station policy templates`, a value-free summary that clients can read,
[managed settings](#settings) (defaults and fixed values for Station
settings), and these limits: the [approval-mode ceiling](#approval-mode-ceiling)
(`maxApprovalMode`), three [capability switches](#capability-switches)
(`telemetry`, `webhookAutomations` and `registries`),
[network exposure](#network-exposure) (`clients`),
[update control](#update-control) (`updates`) and the
[engine limit](#engines) (`engines`). A policy that contains any other limit
key is refused as an unknown limit. Station never accepts a key it does not
enforce, so a machine never looks managed when it is not.

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
| `limits` | no | `maxApprovalMode`, the [capability switches](#capability-switches), `clients`, `updates` and [`engines`](#engines). |
| `limits.maxApprovalMode` | no | `"ask"`, `"auto"` or `"never"`. See [Approval-mode ceiling](#approval-mode-ceiling). |
| `limits.clients` | no | A list of `"desktop"`, `"local-browser"` and `"remote"`. See [Network exposure](#network-exposure). |
| `limits.updates` | no | How Station updates itself. See [Update control](#update-control). |

Station refuses any other key, at any level. An unknown key may be a
restriction from a newer release, and Station will not run while it cannot
enforce one.

Do not put credentials in the policy. Every user on the machine can read it.

## Settings

Each key under `settings` is a Station setting key, the name `station config
get` and `station config set` use (for example `defaultMaxTurns`). Each entry
has exactly two keys:

- `"locked": true` fixes the Station-level value and project overrides
  (see [What a lock does not cover](#what-a-lock-does-not-cover) for narrower
  values that still apply). Users, agents and the offline CLI cannot change
  it, in Settings or in a project's settings, and Settings shows the
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

### What a lock does not cover

A lock fixes two things: the Station-level value, and the project overrides
described above. Some settings also have a narrower value, set on an Agent, a
connection, a conversation or a person's own account, that Station applies
before the Station-level value. A lock does not change those. To bound them,
use limits: for approvals, [`limits.maxApprovalMode`](#approval-mode-ceiling) is the hard bound.

| Setting | Still applies over a lock |
| --- | --- |
| `defaultApprovalMode` | A mode a person picks for a conversation, an Agent's own approval default and a person's per-engine default still apply. The hard approval bound is `limits.maxApprovalMode` (#4518). |
| `region` | An Agent's own region, then a model connection's region, still apply before this one. |
| `defaultModel` | An Agent's own model, the model a person picks for a chat, and a model connection's own default model still apply before this one. |
| `defaultLLMProvider` | An Agent's own model connection and the connection a person picks for a chat still apply. |
| `invokeModel` | An invoke request that names its own model still uses it. |
| `structureModel` | `approvalGuardian`'s own model, `reviewGuideModel` for review guides, and an invoke request that names a structure model still apply first. |
| `defaultMaxTurns` | An Agent's own step limit (`maxSteps` or `guardrails.maxSteps`) still applies first. |
| `defaultMaxOutputTokens` | An Agent's own `guardrails.maxTokens` still applies first. |
| `defaultWorkspaceIsolation` | Task runs, Station delegations and adopted attached sessions always use the shared checkout, and a continued conversation keeps the isolation it started in. |
| `defaultChatFontSize` | A person's own Chat font size (an account setting) still applies first. |
| `usageLimitAutoResume` | A person's "Resume" or "Don't resume" choice on one usage-limit stop decides that stop. |

Every other setting a policy can manage has no narrower value: its lock is the
value in effect. `systemPrompt` is not overridden either: each Agent's own
prompt is added after it. `station policy check` prints the same sentence
under each locked setting in this table.

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
  could not apply a managed value. Use
  [`limits.telemetry`](#capability-switches) to turn telemetry off;
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

## Approval-mode ceiling

`limits.maxApprovalMode` is the broadest approval mode any agent run on the
machine may use, whoever starts it: a person, an agent, an automation, a
scheduled job or a webhook.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://help.example.com/station",
  "limits": { "maxApprovalMode": "auto" }
}
```

The modes, from strictest to broadest, are `ask` (Ask first), `auto` (Auto)
and `never` (Full access). A ceiling of `never` restricts nothing.
`connection-default` is not accepted as a ceiling: it is not a mode but
"whatever the engine's own settings say", which Station cannot rank.

Under a ceiling:

- **A choice above it is refused.** Picking a mode above the ceiling for a
  chat, at its start or later, is refused for everyone, the operator
  included, with "Example Corp's policy manages approval modes: the broadest
  allowed is Auto. For help, visit https://help.example.com/station". So is
  changing this Station's default approval mode to a mode above it. Nobody
  can be granted full access while the ceiling is below `never`, so no
  device's full-access grant takes effect either.
- **A default above it is lowered to it.** A new chat whose default (the
  Agent's, the project's, this Station's, a person's saved default, or the
  mode an automation rule or a delegation carries) is above the ceiling
  starts at the ceiling. A default saved before the policy was installed
  stays saved, and applies again if the policy is removed. `GET
  /config/app`, and the response to a change, report this Station's default
  as it applies (lowered to the ceiling). Saving a mode at or below the
  ceiling stores it, and it then applies without the policy too. A mode a client
  sends as its default (for example `station chat --approval-mode=never`) is
  lowered the same way. Writing Full access as an Agent's own default is
  refused; an Agent that inherits Full access from this Station's saved
  default starts at the ceiling.
- **A personal default follows the ceiling.** A chat started from a person's
  saved default records it as a default, not a choice, so if the policy is
  later tightened that chat is lowered to the new ceiling rather than
  stopped.
- **A chat already above it stops.** A chat whose chosen mode is above the
  ceiling starts no new turn, and does not restart, until someone lowers its
  mode. The turn is refused with the same message.
- **The engine's own default is not used.** Where no mode is chosen and no
  default applies, Station normally leaves the engine on its own settings,
  which can be broader than the ceiling. Under a ceiling it asks the engine
  for Ask first instead.
- **Session-wide edit approval is a single approval.** Under a ceiling of
  `ask`, "Auto-accept file edits for this session" approves only the edit in
  front of you, because keeping it would move the chat to Auto.

The approval picker shows the modes above the ceiling disabled and marked
"Managed", under the same message.

A managed `settings.defaultApprovalMode`, locked or a default, is this
Station's default and must be at or below the ceiling: a broader one is
refused when Station starts. The ceiling is the hard bound a lock is not (see
[What a lock does not cover](#what-a-lock-does-not-cover)): the per-chat
picks, Agent defaults and personal defaults a lock leaves in place are still
refused or lowered as described above. While `defaultApprovalMode` is locked,
a project write that sets the project's approval default is refused as locked
(`managed_setting_locked`), even when the value is also above the ceiling.

### This is not a sandbox

The ceiling decides which approval mode Station asks the engine for.
Engines still enforce their own approvals: an engine's allow rules, hooks
and read-only classifier can let a call run without a Station prompt in any
mode, as they do without a policy. Engines that have no approval control
Station can set are not capped:

- engines with no approval mode at all (for example Ollama, Amazon Bedrock
  and Station's own agent runtime);
- ACP engines whose approval rules Station does not set when it launches
  them (see [ACP](acp.md)); they keep their own settings. ACP's own
  full-access modes are refused where Station recognizes them.

Muse Code's `muse exec` mode has no way to ask for approval, so it always
runs as Auto inside Muse's sandbox. Under a ceiling of `ask`, a Muse chat
that would run through `muse exec` (because `muse serve` is turned off or
fails to start) does not start, and says why. Under `auto` it runs as usual.

A plugin Agent's tool approvals (`autoApprove`, `unattendedAutoApprove`) can
be removed or narrowed under a ceiling, but not added to.

A user who changes how the engine is launched can also defeat engine
approvals: a wrapper earlier on the `PATH` Station runs with, an engine
connection's environment variables and config folder (`configHome`), or an
ACP connection's command and arguments. A locked [engine entry](#engines)
with an absolute `binaryPath` and a pinned `environment` takes that launch
away from the user; see
[What a locked launch closes, and what it does not](#what-a-locked-launch-closes-and-what-it-does-not).
Without one, treat the ceiling as protection against choosing a broader mode,
not against a user who changes how the engine is launched.

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
| Windows | `C:\Program Files\Tailscale\tailscale.exe` (Tailscale's installer) | The same owner and ACL rule as the [policy file](#where-to-install-it): the program, its folder and every folder up to the drive must be owned by Administrators, SYSTEM or TrustedInstaller, let no one else change them, and not be links or junctions. |

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
even when the server refuses to start because of the policy. It reads only the
[policy file](#where-to-install-it). When device management delivers a policy
instead, through a
[configuration profile](#deploy-with-a-macos-configuration-profile) or
[Group Policy](#deploy-with-group-policy-or-intune), the desktop app does not
read it: it turns its own updates off and shows "Station's update policy comes
from your organization's device management; desktop updates are managed
there". It does this whatever the file says, because a file beside a profile
or the registry key is already a startup error. So a mirror delivered through
device management leaves desktop updates off rather than mirrored; to route desktop updates to a mirror, install the policy as the
file. The server, `station upgrade` and the Station service's update read
every source. On Windows the desktop app checks the policy file and every ancestor
through open handles. Owners must be Administrators, SYSTEM or TrustedInstaller;
untrusted write grants and reparse points refuse updates, using the same file,
policy-folder and ancestor-folder roles as the server. Unreadable security
descriptors refuse updates too. If the desktop app
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
refused there. The desktop app can use a mirror from an administrator-owned policy file on
macOS, Linux and Windows. Device-management sources still disable desktop
updates rather than select a mirror.

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
| `allowed` | The engines that may run: any of `claude`, `codex`, `muse`, `acp` (every ACP connection), `station-agent` (Station's own agent) and `remote-task` (chats on a remote task engine; `remoteTasks` still names which vendors). Leave it out to allow every engine. An engine a plugin adds is never on the list, so an allow list turns plugin engines off. |
| `acpRegistryAgents` | `false` stops ACP connections added from the public ACP registry from running and from being added. A custom ACP connection is still allowed while `acp` is. `true` is refused. |
| `engineHostAuth` | `"off"` stops Station giving any engine an access token from its own engine sign-in store (Kiro without kiro-cli asks for one). Engines that keep their own sign-in, such as kiro-cli, are unaffected. `"allowed"`, or leaving it out, lets it. Also off whenever `acp` is not allowed. |
| `remoteTasks` | The remote task engines that may be used: any of `devin`, `github-copilot` and `cursor`. A remote task runs on the vendor's machines, so prompts and repository code leave the computer. Unlike every other key here, leaving it out restricts: on a machine with a policy, a vendor this list does not name is off. Without any policy, the Feature Preview and each connection's acknowledgement decide. See [remote task engines](../decisions/remote-task-engines.md). |
| `instances.<engine>` | How every connection of `claude`, `codex`, `muse` or `acp` is launched. `station-agent` runs inside Station and has no launch to pin. |

Station refuses an unknown engine id, a repeated one, and an `instances`
entry for an engine `allowed` leaves out.

### An engine that is not allowed

An engine the policy does not allow is unavailable everywhere:

- Starting a chat on it, sending a turn to an existing chat on it, delegating
  to it, and setting up or adding a connection for it are refused with "Example Corp's policy
  manages which engines run on this computer: codex is not allowed." and the
  support link. Over HTTP that is a `403` with code
  `managed-policy-engine-refused`.
- Its existing chats are kept. They do not run while the policy is installed,
  and run again if it is removed.
- Its connection reads as disabled, and the engine pages mark it "Managed by
  Example Corp" and "Not allowed".
- For `station-agent`, every run of Station's own agent is refused the same
  way: a direct chat (an active agent, or one started for a model you pick),
  `/invoke`, and a scheduled job. Station's own work on your model
  connections that is not an agent run (chat titles, session summaries, the
  approval guardian and review guides) still runs. A direct chat on an Agent
  bound to an engine the policy does not allow is refused even when you pick
  a model, rather than run on Station's agent instead.
- Station does not use its account credentials: the engine page reports its
  usage and sign-in status as unavailable, without reading the credential
  (no Keychain, no credentials file) or calling the engine's vendor, and
  setting it up (importing an account, adding a profile, starting a sign-in)
  is refused. For an ACP engine, its sign-in view and a new key are refused
  and a key stored for it is never read. Removing a profile or a stored key
  still works.
- Station never starts its program: it is not checked for prerequisites or
  its version (at startup, for system status or for readiness), asked for its
  models, its sign-in status or how it signs in (the Accounts page), probed
  for availability (at startup or periodically) or launched for sign-in.

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

With a profile installed, the desktop app turns its own updates off; see
[What each surface does](#what-each-surface-does).

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

With the registry key present, the desktop app turns its own updates off;
see [What each surface does](#what-each-surface-does).

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
| Managed settings (JSON) | `ManagedSettings` (`REG_DWORD` state), `ManagedSettingsJson` (`REG_MULTI_SZ`, lines joined) | `settings` (see [Settings](#settings)) |
| Broadest approval mode | `ApprovalCeiling` (`REG_DWORD` state), `MaxApprovalMode` (`REG_SZ`: `ask`, `auto` or `never`) | `limits.maxApprovalMode` |
| Allow usage data and telemetry | `Telemetry` (`REG_DWORD`) | `limits.telemetry: false` when Disabled |
| Allow webhook automations | `WebhookAutomations` (`REG_DWORD`) | `limits.webhookAutomations: false` when Disabled |
| Allowed plugin and skill registries | `RegistryAllowList` (`REG_DWORD` state), `RegistryAllowedUrls` (`REG_MULTI_SZ`, one URL per line) | `limits.registries.allowedUrls` |
| Allow unsigned registry packages | `RegistryUnsignedPackages` (`REG_DWORD`) | `limits.registries.unsignedPackages: false` when Disabled |
| Allow the default skill registries | `DefaultSkillRegistries` (`REG_DWORD`) | `limits.registries.defaultSkillRegistries: false` when Disabled |
| Allow engine installs from the ACP registry | `AcpRegistryInstalls` (`REG_DWORD`) | `limits.registries.acpRegistryInstalls: false` when Disabled |
| Allowed clients | `Clients` (`REG_DWORD` state), `ClientDesktop`, `ClientLocalBrowser`, `ClientRemote` (`REG_DWORD` each, 1 checked) | `limits.clients`, the checked kinds |
| Allow updates | `Updates` (`REG_DWORD`) | `limits.updates.mode: "off"` when Disabled |
| Update mirror | `UpdateMirror` (`REG_DWORD` state), `UpdateFeedUrl` (`REG_SZ`) | `limits.updates.feedUrl` |
| Allow the nightly channel | `NightlyChannel` (`REG_DWORD`) | `limits.updates.allowNightly: false` when Disabled |
| Allowed engines | `AllowedEngines` (`REG_DWORD` state), `EngineClaude`, `EngineCodex`, `EngineMuse`, `EngineAcp`, `EngineStationAgent`, `EngineRemoteTask` (`REG_DWORD` each, 1 checked) | `limits.engines.allowed`, the checked engine ids |
| Allow ACP registry agents | `AcpRegistryAgents` (`REG_DWORD`) | `limits.engines.acpRegistryAgents: false` when Disabled |
| Allow Station to sign engines in | `EngineHostAuth` (`REG_DWORD`) | `limits.engines.engineHostAuth: "off"` when Disabled |
| Allowed remote task engines | `RemoteTaskEngines` (`REG_DWORD` state), `RemoteTaskDevin`, `RemoteTaskGitHubCopilot`, `RemoteTaskCursor` (`REG_DWORD` each, 1 checked) | `limits.engines.remoteTasks`, the checked vendor ids. Not Configured allows none. |
| Engine launch configuration (JSON) | `EngineInstances` (`REG_DWORD` state), `EngineInstancesJson` (`REG_MULTI_SZ`, lines joined) | `limits.engines.instances` |

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
STATION_MANAGED_POLICY_INVALID: Station cannot use the managed policy at /etc/station/policy.json: it does not match the policy schema (limits.maxApprovalMode: must be "ask", "auto" or "never"). Station will not start until an administrator fixes or removes it.
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
  an unknown key, a [settings entry Station cannot apply](#settings), a
  limit key this release does not know, a limit value it refuses, or a
  managed default approval mode above `maxApprovalMode`;
- more than one policy source is installed: a file and a configuration
  profile, or a file and the registry key.

The desktop app shows that the organization's policy cannot be used and does
not retry; restarting cannot fix it. `station start` checks the policy the
way `station policy check` does before it starts anything: it prints the same
line and exits `1` without starting a server or the UI, so nothing listens
while the policy is unusable.
Fix or remove the policy, then start Station again.

## What clients see

Authenticated clients can read `GET /api/settings/managed-policy`. It returns
`{ "state": "none" }`, or the source, the fingerprint and a summary: the
organization, the support link, the locked setting keys and the effective
limits, including the approval-mode ceiling, each capability switch and the
registry allow list. It never
returns a setting value or the update feed URL; for `limits.updates` it
returns `mode`, `allowNightly` and whether a mirror is set (`mirror`). A policy
that sets `limits.engines` adds `summary.engines`, which names the allowed
engines, whether ACP registry agents may run, and which launch fields and
environment variable names each engine has pinned. It never returns a launch
value, because a launch argument or environment value can carry a gateway
token; `summary.limits` then omits `engines`.

A request refused by the approval-mode ceiling returns `403` with
`"code": "managed-policy-approval-ceiling"`.

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
