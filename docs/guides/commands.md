# Custom Slash Commands

Station supports custom slash commands per agent, allowing you to define reusable prompts with parameters.

## Overview

Custom commands are defined in an agent's `agent.json` file under the `commands` field. Each command can have:
- A name (used as `/commandname`)
- A description (shown in autocomplete)
- A prompt template with `{{parameter}}` placeholders
- Parameter definitions with types, defaults, and descriptions

## Example Agent Configuration

```json
{
  "name": "Example Agent",
  "prompt": "You are a helpful assistant.",
  "commands": {
    "summarize": {
      "name": "summarize",
      "description": "Summarize text or a topic",
      "prompt": "Please provide a concise summary of: {{text}}",
      "params": [
        {
          "name": "text",
          "description": "The text or topic to summarize",
          "required": true
        }
      ]
    },
    "explain": {
      "name": "explain",
      "description": "Explain a concept",
      "prompt": "Explain {{concept}} in {{style}} terms",
      "params": [
        {
          "name": "concept",
          "required": true
        },
        {
          "name": "style",
          "required": false,
          "default": "simple"
        }
      ]
    }
  }
}
```

## Usage

In the chat interface, type `/` to see available commands including custom ones:

```
/summarize This is a long piece of text that needs summarizing
/explain quantum computing technical
/explain blockchain
```

## Parameter Expansion

Parameters are matched positionally:
- `/command arg1 arg2` → first param gets `arg1`, second gets `arg2`
- Missing optional parameters use their default value
- Template placeholders `{{paramName}}` are replaced with values

## Command Composition

Commands can reference other commands in their prompts:

```json
{
  "review-and-summarize": {
    "name": "review-and-summarize",
    "prompt": "/review {{content}}\n\nThen /summarize the key findings",
    "params": [{"name": "content", "required": true}]
  }
}
```

## Notes

- **Hot-reload**: Agent and command changes are detected automatically via file watcher — no server restart needed
- **Autocomplete**: Custom commands appear in the `/` autocomplete menu
- **Scoped to agent**: Each agent has its own set of custom commands
- **No nesting yet**: Commands are expanded once (no recursive expansion)
