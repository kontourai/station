# station-control-tool-use

Sends each case's conversation to a Claude model with Station's real
`station-control` tool list and grades the tool calls in the model's next
response. Each case reproduces a situation an agent got wrong, or ordinary
work where no Station tool belongs.

## What the model sees

- **Station Control tools:** this checkout's `tools/list` (name, description,
  input schema), read over an in-memory MCP connection from
  `createSelectedStationControlMcpServer`, named as Claude Code names them
  (`mcp__station-control__<tool>`). A case's `assurance` picks the listing:
  `bound` is what Claude sessions get, `delegated-custody` what Codex and ACP
  get.
- **Harness tools:** small `Bash`, `Read`, `Edit` and `Task` tools standing in
  for the engine's own (`tools.ts`). They are the eval's text, not Station's.
- **System prompt:** a short coding-agent preamble. `--instructions` appends
  Station's composed orchestration instructions (the
  `station-orchestration-instructions` Feature Preview, off by default).
- **Results:** refusals come from `stationControlRefusalBody` in
  `station-control-policy.ts`; other prior results are the case's own data.

All Station tools are offered up front, as an engine without tool search
sees them. Claude Code normally defers MCP tools behind ToolSearch, so this
measures what the descriptions teach once loaded, not whether ToolSearch
finds them.

## Run

```sh
npm run eval:station-control-tool-use -- --context
npm run eval:station-control-tool-use -- --case second-model-review --dry-run
npm run eval:station-control-tool-use -- --samples 3 --out /var/tmp/evals/main
npm run eval:station-control-tool-use -- --samples 3 --out /var/tmp/evals/mine --baseline /var/tmp/evals/main/results.jsonl
```

The default model is `claude-haiku-5-5`; pick another with `--model`. The run
exits 1 when a case that passed every baseline sample now fails. The client
uses only `ANTHROPIC_API_KEY` against `https://api.anthropic.com`, never a
session's auth token or proxy base URL.

Cost: one request per sample, about 30,000 input tokens each (the tool list is
most of it). Ten cases at three samples is about 0.9M input tokens, under
$0.15 on Haiku 5.5. The summary records the tokens a run used.

## Cases

`cases.json`; the `ToolUseCase` type in `grade.ts` documents every field.

| Case | Kind | Source | Checks |
| --- | --- | --- | --- |
| out-of-scope-retry-in-own-project | bad | #3648 | After a scope refusal, `delegate_task` again in its own Project instead of giving up or using a CLI. |
| second-model-review | bad | #4716 | A second model's review goes through delegation, not a model CLI. |
| wait-for-delegated-task | bad | #4716 | Waiting on a delegated task uses `wait_session`/`get_task`, not a sleep loop. |
| chart-without-a-server | bad | #4716 | A chart for the user goes through `html_preview`/`html_render`, not a local server. |
| declare-opened-pull-request | bad | #3161 | After `gh pr create`, the pull request is declared with `declare_pull_request` and its `ref`. |
| look-for-existing-work-first | guard | #4092 | Checking for existing work uses conversation search or active work. |
| custody-delegate-without-targets-tool | guard | #4716 | A Codex/ACP session picks an Agent without `list_delegation_targets`. |
| ordinary-fix | control | #4716 | A one-line fix uses no Station tool. |
| explain-code | control | #4716 | A question about the code uses no Station tool. |
| own-subagent-for-quick-helper | control | #4716 | A quick helper in this checkout is not a Station delegation. |

Checks: `firstCallAnyOf`, `calls` (with partial `args`: `null` means absent,
`~text` a case-insensitive substring, dotted paths for nested keys),
`callsMustNot`, `shellMustNot` (regexes over `Bash` commands) and
`noStationTools`. Only the first response is graded; prior tool calls are
replayed, not executed.

To add a case: write it, check it with `--dry-run --case <id>`, run it on the
text before your fix (it must fail) and after (it must pass).

## Results

None recorded yet: the cases were written without an API key, so none has
been shown to fail on the text it was written against. Record the first
paired run (main's text and the change's, same model) here.
