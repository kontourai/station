---
name: inspect-onboarding
description: Inspect a project onboarding document and report actionable gaps without changing files.
---

Read the user-selected onboarding document in the project. If the file is
missing or project/file access is unavailable, stop and explain what is needed.
Do not invent document content or claim the project builds.

Compare its prerequisites, first-run steps and expected result against actual
project configuration and available scripts. Cite the document and config
references for each discrepancy. Report confirmed gaps separately from steps
you could not verify. Ask before any execution or file changes; this inspection
only reads and produces a Markdown report in the conversation.
