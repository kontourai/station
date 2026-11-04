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
a value-free summary that clients can read, and one limit: the
[approval-mode ceiling](#approval-mode-ceiling) (`limits.maxApprovalMode`). It
does **not** yet enforce any setting or any other limit. A policy that
contains a setting entry or another limit key is refused with "not supported
by this version of Station". Station never accepts a key it does not yet
enforce, so a machine never looks managed when it is not.

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
| `limits` | no | May hold only `maxApprovalMode` in this release. |
| `limits.maxApprovalMode` | no | `"ask"`, `"auto"` or `"never"`. See [Approval-mode ceiling](#approval-mode-ceiling). |

Station refuses any other key, at any level. An unknown key may be a
restriction from a newer release, and Station will not run while it cannot
enforce one.

Do not put credentials in the policy. Every user on the machine can read it.

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
  an unknown key, a setting entry, a limit key other than `maxApprovalMode`,
  or a managed default approval mode above `maxApprovalMode`;
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
limits (`{ "maxApprovalMode": "auto" }`). It never returns a setting value.
A request refused by the approval-mode ceiling returns `403` with
`"code": "managed-policy-approval-ceiling"`.

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
