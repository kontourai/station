# Evals

An eval runs a real model against Station's real text and scores what the
model does. Use one where a unit test cannot help: model output changes from
run to run, and a small copy change can move it.

Write or run an eval when a change affects what a model sees or does: the
Station Control tool descriptions and schemas, tool results and refusal copy,
or the orchestration instructions Station injects.

| Eval | Measures |
| --- | --- |
| [station-control-tool-use](station-control-tool-use/) | Whether a model picks the right Station Control tool, and avoids the shell workaround, for situations agents got wrong. |

## Run an eval

Evals call paid models. CI and hooks never run them; CI runs only the graders'
unit tests in `scripts/__tests__/`. A run needs `ANTHROPIC_API_KEY` in the
environment and skips with a message without it. Never print or commit a key.

```sh
npm run eval:station-control-tool-use -- --case second-model-review --samples 1 --out /var/tmp/evals/check
```

Start with one case and one sample to check the setup. Write runs outside the
checkout (`--out`); they are evidence for a pull request, not source.

## Rules

- **Import, never copy.** An eval imports the tool definitions, instructions
  and refusal copy from source, so it always tests the current text.
- **Cases come from real incidents.** A case reproduces a real bad
  experience, or guards a real good one, and names its source (a PR, issue or
  commit).
- **A case must fail before its fix.** Add the case first. It must fail on
  the old text and pass on the new. If you change a case, it must still fail
  on the text it was written against; prefer fixing Station to loosening a
  case.
- **Controls.** Include cases where the right action is ordinary work and no
  Station tool. They catch a fix that overcorrects.
- **Several samples.** Run each case several times (default 3). A case fails
  when half or more of its samples fail.
- **Compare with a baseline on the same model**, not with an absolute score:
  run `main`'s text, then yours, and pass `--baseline <results.jsonl>`.
- **No user data** in cases. Use `/home/user/app`, `acme/app` and authored
  Acme content.

## The shape of an eval

Each eval is a directory here, shaped like
[station-control-tool-use](station-control-tool-use/):

- `run.ts` is the entry point, with a package script named `eval:` plus the
  eval's directory name. Flags: `--out <dir>`, `--model <id>`,
  `--samples <n>`, `--case <id>` (repeatable), `--baseline <results.jsonl>`,
  `--dry-run` (prints request bodies, no model calls) and `--context` (prints
  what the model is offered, in bytes; no key).
- Cases are data beside it, each with an `id`, a `kind` (`bad`, `guard` or
  `control`), a `source` and its checks.
- The grader is plain logic, unit-tested in `scripts/__tests__/` (for this
  eval, `station-control-tool-use-eval.test.ts`).
- A run writes `results.jsonl` and a `summary.md` to `--out`.

When a second eval needs code the first already has (the model client,
sampling, the summary), move it into a shared directory here. Not before.
