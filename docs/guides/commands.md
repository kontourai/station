# Custom Slash Commands

A slash command can run a Station UI action, expand a reusable prompt, or pass
text to the selected engine. Its behavior depends on the command source and
engine connection. The command catalog shows the source and, where available,
why a command is unavailable.

## Overview

| Source | Where it comes from | What handles it |
| --- | --- | --- |
| Built-in | Station's command registry, such as `/help`, `/stats`, and `/model` | A UI handler; some actions require a capability supported by the current engine |
| Authored Agent command | The Agent specification's `commands` field | Positional prompt expansion in the chat client |
| Command skill | An enabled skill command, offered globally or attached through the Agent's `skills` list | Skill body lookup, variable validation, then prompt expansion |
| MCP prompt | A prompt offered by an MCP server in the Station agent's tool view, typed as `/<server>:<prompt>` | The server reads the prompt (`prompts/get`) with the typed arguments; its text is sent as the turn |
| Engine command | Commands advertised by an engine connected through ACP | Raw command text sent to that engine |

For an ACP connection, the catalog and handler use the engine's commands;
Station does not first expand authored commands or command skills. Other
connections check authored commands, then offered command skills, then MCP
prompts, then built-in handlers. Unrecognized commands pass through for Claude and Codex chat
providers; other providers get an unknown-command notice. A command appearing
in a catalog is not proof that a remote engine will accept it.

This guide describes Station's chat-client path. Sending a slash-prefixed
string directly through the Session API does not invoke these UI handlers.
See [the ACP guide](acp.md) for engine discovery and its autocomplete limits.

## Example Agent Configuration

The `commands` field belongs to the [Agent specification](agents.md).
It is persisted with the Agent under `<STATION_HOME>/agents/<id>/agent.json`
and returned in the enriched Agent projection. Add the following field to an
existing valid specification; this is not a complete Agent file:

```json
{
  "commands": {
    "summarize": {
      "name": "summarize",
      "description": "Summarize text or a topic",
      "prompt": "Summarize: {{text}}",
      "params": [
        { "name": "text", "description": "Text or topic", "required": true }
      ]
    },
    "explain": {
      "name": "explain",
      "description": "Explain a concept",
      "prompt": "Explain {{concept}} in {{style}} terms",
      "params": [
        { "name": "concept", "description": "Concept to explain", "required": true },
        { "name": "style", "description": "Explanation style", "default": "simple" }
      ]
    }
  }
}
```

Keep the map key and `name` identical and lowercase. The catalog displays
`name`; dispatch looks up the lowercase typed word in the map. Parameters have
names, descriptions, an optional `required` declaration, and string defaults;
they do not have a typed-value conversion system. The Agent editor currently
displays authored commands and links to the catalog; it is not a parameter
editor.

## Usage

Type `/` in the chat composer to inspect available commands. Quote text that
must be one argument:

```text
/summarize "This is a long piece of text"
/explain "quantum computing" technical
/explain blockchain
```

The non-ACP client parser groups single- or double-quoted words. A backslash
escapes the next character outside single quotes. An unterminated quote shows
an error without dispatching. ACP passthrough occurs before that local refusal,
so the selected engine interprets its own command text.

## Parameter Expansion

For an **authored Agent command**, arguments fill parameters positionally.
Each declared `{{name}}` is replaced using that argument, its default, or an
empty string. An empty argument also falls through to the default. Extra words
are ignored; they are not joined into the last parameter. The current handler
does not enforce `required`, so a missing required argument can produce an
incomplete prompt. Named `key=value` assignment is not supported on this path.
[#2764](https://github.com/kontourai/station/issues/2764) tracks validation of
missing required and surplus arguments.

For a **command skill**, a word such as `style=technical` assigns a declared
variable by name. Remaining words fill unassigned variables in declaration
order. Extra positional words are rejected. Empty/whitespace values fall back
to a usable default; a variable with neither a value nor a usable default
produces an error and nothing is sent. The handler reads the body on demand;
a body-read failure also stops dispatch. The skill Test surface uses the same
substitution helper.

For an **MCP prompt**, arguments use the same `name=value` and positional
parser as skill variables, in the order the server declares them. MCP prompt
arguments are named strings with an optional `required` flag; the protocol
gives them no other type. A missing required argument, an unknown argument,
or a value longer than 12,000 characters is refused and nothing is sent. The
server-side run also refuses prompt content Station cannot insert as message
text (image, audio, blob and resource-link content) and output over 100,000
characters, rather than dropping or cutting it. A prompt whose messages are
all `user` text is sent as that text; any `assistant` message is labelled by
role in the inserted text.

A prompt is offered only from a server the agent attaches (`tools.mcpServers`)
and only when the agent's `tools.available` restriction admits
`<server>_<prompt>` — the same pattern grammar its tools use — so an agent
narrowed to specific tools is not offered that server's prompts by default.
Station-managed servers (`station-control`, `station-knowledge`,
`station-docs`) are not asked for prompts.

These are separate implementations. Do not infer the skill's validation
behavior from the Agent command's `required` field, or vice versa. A recorded
skill run is attempted after expansion; it does not prove the engine completed
the resulting prompt.

Both substitution paths currently use JavaScript replacement-string semantics:
for example, `$&` inserts the matched placeholder and `$$` becomes one dollar
sign. Values containing those patterns are not preserved literally. This is a
substitution limitation, not shell interpretation.
[#2763](https://github.com/kontourai/station/issues/2763) tracks literal-value
preservation in both paths.

## Command Composition

Expansion produces message text, not another pass through the command router.
For example, this prompt does not automatically execute two commands:

```text
/review {{content}}
Then /summarize the key findings
```

An engine can interpret the resulting text according to its own behavior;
Station's client does not provide recursive command execution or a workflow
transaction here.

## Notes

- The catalog can retain disabled skill declarations with a diagnostic. The
  server resolves skill-command collisions; attaching a losing skill does not
  change which skill owns the command word.
- Capability-gated built-ins remain visible in the full catalog with a reason;
  autocomplete filters to commands marked available.
- Configuration watching can refresh Agent definitions. It is not a guarantee
  that a running engine reloads every setting or that a file edit is immediately
  visible in every client. Follow the [Agent lifecycle](agents.md).
- Prompt substitution is not shell execution. Tools the engine later chooses
  still follow their own authority and approval rules.

## Implementation and evidence

The [catalog](../../src-ui/src/hooks/useSlashCommands.ts) composes sources and
availability; the [hook](../../src-ui/src/hooks/useSlashCommandHandler.ts)
loads the [dispatcher](../../src-ui/src/slashCommands/dispatch.ts) when a
command is submitted. ACP commands pass through without loading it. A failed
dispatcher load reports that nothing was sent. The dispatcher owns command
precedence and authored expansion. The
[catalog helpers](../../src-ui/src/utils/skill-command-catalog.ts) select
offered skills; the [input helpers](../../src-ui/src/utils/skill-commands.ts)
own parsing and skill variable assignment. The
[chat sender](../../src-ui/src/hooks/useActiveChatSessionMessaging.ts) consumes
expanded text or a handled result before its normal turn submission. The
[Agent projection](../../src-server/routes/agents/enriched-agents.ts) exposes
persisted commands; [ConfigLoader](../../src-server/domain/config-loader.ts)
owns file loading/watching. MCP prompts are listed and run by the
[prompt routes](../../src-server/routes/agents/mcp-prompts.ts) over the
[prompt service](../../src-server/services/plugins/mcp-prompts.ts). The
[MCP prompt runner](../../src-ui/src/slashCommands/mcpPrompt.ts) loads when
the dispatcher matches an offered prompt.

Existing [catalog tests](../../src-ui/src/__tests__/useSlashCommands.test.ts) and
[skill-handler tests](../../src-ui/src/__tests__/useSlashCommandHandler.skills.test.tsx)
exercise synthetic chat state and bodies. They do not establish that a live
engine supports a particular slash command. The
[MCP prompt route tests](../../src-server/routes/agents/__tests__/mcp-prompts.routes.test.ts)
run a fixture MCP server's prompt through the real route and `MCPService`;
the [prompt handler tests](../../src-ui/src/__tests__/useSlashCommandHandler.mcpPrompts.test.tsx)
stub only the run request.
