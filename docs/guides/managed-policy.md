# Managed policy

A managed policy lets an organization's IT administrator control Station on
the machines it manages. You install one policy file on a machine. Every
Station server on that machine loads the policy when it starts, applies it to
every client that connects (desktop, browser and mobile), and refuses to start
if it cannot enforce it.

This guide covers what the current release supports. The
[decision record](../decisions/managed-policy.md) explains the design and the
precedence rules. The remaining limits, configuration profiles and Group
Policy arrive in later releases (#4519–#4524). This guide grows with them.

## What this release supports

The current release supports the policy document, the file source, the
fail-closed startup check, `station policy check` and `station policy show`,
a value-free summary that clients can read,
[managed settings](#settings) (defaults and fixed values for Station
settings), and one limit: the [approval-mode ceiling](#approval-mode-ceiling)
(`limits.maxApprovalMode`). It does **not** yet enforce any other limit. A
policy that contains another limit key is refused with "not supported by this
version of Station". Station never accepts a key it does not yet enforce, so a
machine never looks managed when it is not.

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
| `limits` | no | May hold only `maxApprovalMode` in this release. |
| `limits.maxApprovalMode` | no | `"ask"`, `"auto"` or `"never"`. See [Approval-mode ceiling](#approval-mode-ceiling). |

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
use limits: for approvals, `limits.maxApprovalMode` (#4518) is the hard bound.

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
  stays saved, and applies again if the policy is removed. A mode a client
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

The engine's launch configuration still belongs to the user in this release,
and it can defeat engine approvals:

- the `claude` and `codex` executables are found on the `PATH` Station runs
  with, so a wrapper placed earlier on that `PATH` can launch the engine with
  its own flags, such as one that skips permission checks;
- an engine connection's environment variables and config folder
  (`configHome`) point the engine at configuration the user writes, such as
  Claude Code allow rules or hooks;
- an ACP connection's command and arguments are the user's.

Owning these is the engine slice of the managed policy (#4520). Until it
lands, treat the ceiling as protection against choosing a broader mode, not
against a user who changes how the engine is launched.

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
  an unknown key, a [settings entry Station cannot apply](#settings), a
  limit key other than `maxApprovalMode`, or a managed default approval mode
  above `maxApprovalMode`;
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
limits (`{ "maxApprovalMode": "auto" }`). It never returns a setting value.
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
