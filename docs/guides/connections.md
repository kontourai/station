# Connections Guide

Connections power Station's chats and agents. A **Model connection** is a hosted service or
local model server that Station's engine runs inference on; an **Engine** is an agent app such
as Codex or Claude Code that runs its own loop. They appear under **Connections** on the
**Models** and **Engines** tabs, each with one clear readiness label and one next action.

For the precise vocabulary used below, see [docs/glossary.md](../glossary.md).

---

## Read the connection list

Each Model connection or Engine shows exactly one state:

- **Ready** — usable now.
- **Sign in required** — authenticate to finish connecting.
- **Found, not connected** — Station observed a service-specific setup signal; connect it to Station.
- **Setup required** — finish the remaining setup.
- **Limited** — usable with reduced capabilities; review the details.
- **Disabled** — configured but turned off.
- **Unreachable** — configured, but Station cannot reach it.

Select the action on the row. Station keeps transport, process, and connection-kind details
out of the overview; they remain available only where setup or diagnosis needs them.

---

## Saved Station addresses

Open **Manage Stations** in the header to inspect the computers this client
connects to. Each address wraps on narrow screens so its port stays visible.
The row's **More actions** menu provides **Copy address** and **Edit Station**.

Native clients save edits through the shared profile store. A name change
preserves pairing and updates references to that profile, including its default
and project selections. Changing the address requires connecting the device
again: the previous credential is never sent to the new origin. Concurrent
changes to the same name or address are rejected for review rather than
overwritten. The app-managed local Station is not editable through this form.

Clients without the profile owner's editing capability keep shared profiles
read-only; they can still display and copy the complete address. Ordinary
browser-local saved Stations retain their existing edit and endpoint-verification
flow.

On native Desktop, **Add computer → Save an encrypted broker route** records
the Station address, broker address and exact Station enrollment. **Saved broker
routes** lists, edits and removes those records and reports whether this device
has a separately approved Station signing key. Saving a route does not connect,
sign in, pair a Device or grant Project access. Until the broker transport is
wired into the ordinary client, these records remain unconnected and cannot be
selected as direct Station connections or CLI defaults. The CLI also refuses
`--station` and `STATION_TARGET` when they name one of these inert routes.

In the browser, **Manage Stations → Broker routes** can accept a one-time
invitation link or the operator's private JSON invitation after this browser
already holds an independently approved Station signing key. Enter the Station
application origin separately, then
select the saved route. The routing grant stays in browser IndexedDB, outside
the saved Station entry. A selected route uses an encrypted browser channel for
the Station handshake and application requests; a missing grant, retired key or
failed peer connection refuses instead of falling back to direct HTTP. This
pilot uses local ICE host candidates. Remote TURN configuration, the ordinary
key-approval ceremony, account/Device onboarding and native route selection
are still separate work; the screen must not call a routing grant a login.

One broker can serve several Stations, and one Station can be reached through
more than one route. A broker route belongs beneath the Station it reaches; it
is not another Station or a person. A short-lived invitation can enroll one
Device's separate routing grant without sharing the operator's long-lived
broker credential. That grant permits signaling only. The Device must still
approve the Station signing key independently and complete Station account,
Device and Project authorization. The Station operator must explicitly allow
the Device's application Origin; possession of an invitation does not change
that allowlist. See the [local broker lab](local-collaboration-lab.md#separate-self-hosted-broker-and-production-browser-consumer)
for the source-level pilot and its current UI/native limits.

Native Desktop and the CLI share a strict saved-profile file. An older build
that predates broker-route metadata refuses the updated file instead of
discarding fields it does not understand. Update both clients that use the
shared profile root before saving a broker route; [#2404](https://github.com/kontourai/station/issues/2404)
tracks a mixed-version migration. Removing the route in the newer Desktop
removes its metadata without changing the Station or its trust record; other
newer profile fields may still require an updated reader.

## Local first: Ollama (no credentials)

This is the easiest path and needs no cloud account, API key, or AWS setup.

### 1. Install Ollama

Download and install from [ollama.com](https://ollama.com). Ollama runs a local model server on `http://localhost:11434`.

### 2. Pull a model

```bash
ollama pull llama3.1
# or
ollama pull qwen2.5
```

Any chat-capable model Ollama supports works. Smaller models start faster; larger ones are more capable.

### 3. Let Station suggest it

If Station finds Ollama at `http://localhost:11434`, it can show it as a detected suggestion.
Detection is read-only: it does not create a connection or read credentials.

If Ollama was not running when you opened Connections, start it and return to add or verify the
connection in the next section.

### 4. Add or verify an Ollama connection in the UI

1. Open the **Connections** view.
2. On the **Models** tab, find **Ollama**. If it says **Setup required**, select **Set up**. If it is absent, select **Add model connection** and choose Ollama. Its default server URL is `http://localhost:11434`.
3. The connection lists the models Ollama has pulled. If a model you expect is missing, run `ollama pull <model>` and refresh.

### 5. Pick a model

When editing a Station agent, choose your Ollama model from the agent's model picker. Models you have pulled appear there once the Ollama connection is verified.

---

## Add an engine

Codex, Claude Code, OpenCode, Kiro, and similar agent apps are Engines. Use
**Connections → Engines → Add engine** to add one.

1. Select a detected or supported engine, or choose the custom option.
2. For custom setup, enter a name and command. Command arguments, working directory, and other
   raw setup details stay under **Advanced**.
3. Keep the same dialog or sheet open while Station shows **Checking**.
4. Read the single result: **Ready**, **Setup needed**, **Unavailable**, or **Off**. If it is
   not Ready, use the offered retry, edit, or choose-another-engine action before closing.

Detection only says that Station observed a possible local engine; it does not configure it,
read its secrets, or guarantee that it is ready. The UI names the concrete engine, such as
OpenCode or Kiro, rather than exposing its transport as a user category.

The first-run Engines chapter shows the detected, not-yet-connected local Engine subset. Selecting
one there explicitly connects the Engine and creates its External agent together; detection itself
remains read-only until that action.

For the built-in Claude Code Engine, Station chooses between the `claude` executable it finds
installed on your machine and the Claude Code bundled with the Claude Agent SDK:

- The installed executable runs when it reports a version that is not older than the bundled one.
- The bundled copy runs when the installed executable is older.
- The bundled copy also runs when the installed executable does not report a version — Station
  cannot confirm that such a copy runs at all, let alone that it is current.
- The installed executable runs when Station cannot read the bundled version, so an unreadable
  Agent SDK never silently downgrades a working installation.

The Engine's readiness detail names the executable Station will launch and whichever versions it
was able to read.

---

## Route an engine through a model proxy

A Claude Code or Codex Engine connection can send its traffic through a local
model proxy (CLIProxyAPI, VibeProxy, or any Anthropic/OpenAI-compatible
router) instead of logging in directly. Set this in the connection's runtime
config (`agentConnections.<engine>.config` in `config/app.json`):

- `env` — environment variables merged into every engine subprocess the
  connection spawns. Names must be valid env-var names; Station-internal
  secret names and `TMPDIR` are refused. An empty-string value masks an
  inherited variable.
- `configHome` — an explicit engine config home (`~` allowed), applied as
  `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). It wins over the
  station-managed app-home opt-in (`useAppHome`); a selected credential
  profile still wins over both.

For example, to route the Claude Code connection through a keyless local
proxy that pools your subscriptions:

```json
{
  "agentConnections": {
    "claude": {
      "config": {
        "env": {
          "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318",
          "ANTHROPIC_AUTH_TOKEN": "local-proxy",
          "ANTHROPIC_API_KEY": ""
        }
      }
    }
  }
}
```

For Codex, prefer `configHome` pointing at a dedicated home whose
`config.toml` sets `model_provider` to the proxy's provider entry, so model
discovery lists what the proxy serves.

Two boundaries to know: credential login/enrolment children do not receive
`env` (they always run against the engine's normal config root), and changing
`configHome` after sessions exist does not migrate their history — a resumed
thread looks for its transcripts under the home that was active when it last
ran. Malformed or oversized `env` entries (more than 64 entries or a value
over 32 KiB) are dropped silently at save time.

One failure mode to expect: most proxies re-identify requests to the provider
with their own client identity and capability flags, not your engine's. A
proxy build that lags the provider's current client can be refused for models
that require a newer client — with an error telling you to update your local
engine, which is already current — or have newer request fields rejected as
unknown. If a proxied connection fails with a client-version error, update
the proxy first; Station cannot rewrite what the proxy sends upstream, and
unproxied connections are unaffected.

---

## OpenAI-compatible endpoints

Many hosted and self-hosted inference servers expose an OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`). Station connects to these as an **OpenAI-compatible** Model connection.

1. On **Connections → Models**, select **Add model connection** and choose a named service such as **LiteLLM** or **OpenRouter**, or choose **Other OpenAI-compatible**.
2. Confirm the **server URL** for the service's API root (for example, the URL that serves `/chat/completions` and `/models`).
3. Provide an **API key** if the endpoint requires one. Endpoints that need no auth can leave it blank.
4. Verify the connection, then pick a model when editing a Station agent.

---

## AWS Bedrock (optional)

Bedrock is one Model connection option among several — it is **not required** to run Station. It needs valid **AWS credentials** in your environment (see [docs/reference/env-vars.md](../reference/env-vars.md) for the AWS variables and the minimum IAM policy).

1. Make AWS credentials and a region available to Station (e.g. via `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or a configured AWS profile).
2. If Station observes the required AWS environment, it can show Bedrock as a suggestion. That
   observation does not read credential material or create a connection.
3. Select **Add model connection**, choose **Amazon Bedrock**, then choose the region and one of the supported authentication modes: default AWS credentials, a named AWS profile, or a Bedrock API key.
4. Pick a Bedrock model when editing a Station agent.

Bedrock-specific configuration (the AWS `region` and a Bedrock `defaultModel`) is documented in [docs/reference/config.md](../reference/config.md). These fields apply only when you run Bedrock.

---

## Current configuration defaults

`config/app.json` can set which Model connection new projects default to:

- `defaultLLMProvider` — the connection ID used for inference by default.
- `defaultModel` — the default model ID (a Bedrock model ID when using Bedrock; a local model name such as `llama3.1` when using Ollama).

See [docs/reference/config.md](../reference/config.md) for the full `app.json` reference and an Ollama-first example.

The chat composer always names the active connection and model. Open it to
search across ready Model connections and Engines, filter by connection or
Favorites, and choose the exact model for this chat. Connections that still
need setup remain visible with their status, but cannot create an invalid
selection.

Favorites, recent choices, hidden models, and model order are saved on this
device. Manage a connection's model list from its detail page. **Use project
default**, **Use agent default**, or the other named reset shown in the picker
restores both the default connection and model.

---

## Developer services and computers

Connections has one clear home for each relationship:

- **Computers** shows Stations this device can reach. **Remote work** shows
  computers where this Station can run delegated tasks. **Add computer** asks
  the goal once and opens the right pairing or SSH setup.
- **Developer services** shows Git, GitHub, GitLab, and MCP tool servers.
  Station reports the host's actual install and sign-in state. Each service
  offers one next action; installation and authentication guidance stays with
  that service instead of appearing as a separate CLI checklist.
- When an agent tool depends on a disconnected tool server, **Repair
  connection** opens that exact server. Station does not label the tool
  available or ask the user to add it first.
- A stdio MCP integration can bind a named child environment variable to a
  local Datum reference. The binding is granted to that exact integration and
  materialized only while a fresh child is established; Station-control and
  non-stdio transports reject authored bindings. A stored legacy credential is
  removed only after a fresh bound child succeeds.

## Pairing scopes on this computer

Device-pairing scopes apply even when a desktop app or CLI talks to Station on
the same computer. A device paired as **Read-only** can view and stream state,
but cannot create, change, or delete resources and cannot open a terminal. If
you expected to operate the local Station, revoke that device entry and pair it
again as **Standard**. Standard can read, operate, and open a terminal.

This tightening makes the permission shown during pairing effective for
loopback connections as well as remote ones. See the rationale in
[the peer-pairing design decision](../design/station-peer-pairing.md#loopback-scopes-are-not-an-exception-station1198).

## Simplified setup program

The unified Providers home, guided setup, chat model picker, prerequisite
guidance, shortcut editor, and final Settings integration now share one
vocabulary. Settings explains where values live and sends provider, developer
service, and computer setup to Connections instead of duplicating those controls.

| Follow-on slice | Issue |
|---|---|
| Unified Providers home and readiness language | #1349 — shipped |
| Provider detail and guided credential setup | #1350 — shipped |
| Default-chat Model picker | #1351 — shipped |
| Connection and tool prerequisite guidance | #1352 — shipped |
| Keyboard shortcut editor | #1353 — shipped |
| Settings integration and final interface polish | #1354 — shipped |

---

## Route aliases

The Connections, Guidance and Tool-server URLs have a single canonical route per concept; the previously-shipped URLs listed below still work because navigation-store ingestion rewrites them to the canonical route via `getLegacyPathRedirect` (see `src-ui/src/app-shell/routing.ts`) before view resolution. Aliasing covers the paths in this table, not every historical URL (e.g. the pre-rename `/connections/runtimes` is not resolved).

| Concept | Canonical route | Aliases (still work) |
|---|---|---|
| Model providers | `/connections/providers` | `/connections/models`, `/manage/providers` |
| Engines | `/connections/engines` | `/connections/agent-apps`, `/connections/agents` |
| Local-command provider setup | `/connections/acp` | — |
| Skills | `/guidance?tab=skills` | `/skills`, and the retired `/playbooks`, `/prompts`, `/manage/prompts` |
| Tool servers | `/connections/tools` | `/integrations`, `/tools`, `/manage/integrations` |
| Registry | `/registry` (optionally `/registry/:tab` for `agents`\|`skills`\|`integrations`\|`plugins`\|`layouts`\|`kits`) | — |

In-app navigation (sidebar links, `navigate()`/`onNavigate()` call sites) always emits the canonical route via `getPathForView`. Aliases are resolved for incoming/deep-link paths only — they are never generated by the app itself, so the address bar will show the canonical URL after any in-app navigation even if you arrived via an old bookmark.
