---
---

Restore VoltAgent structured output for review guides, titles and summaries, and preserve global-invoke identity options. Guardian reviews on both VoltAgent and Strands previously fell back to defer on schema adapter errors; configured guardians now receive real allow/deny/defer verdicts. Malformed verdicts still defer. Guardian policy is unchanged; the guardian remains off by default.

When enabled, a guardian allow is authoritative even in the default review mode: it skips attended approval prompts, overrides the ordinary unattended refusal (including tools absent from unattendedAutoApprove), and overrides a delegated child's denyApprovals denial. There is no destructive or sensitive tool-class ceiling; explicit askBeforeUse, Project policy and preceding allow/block and config-protection checks still apply. Prompt-injected tool data can still persuade the guardian to allow. Existing enabled installations should review their guardian mode and instructions before relying on the restored decisions.

Convert structured schemas for Strands and explain oversized guide excerpts accurately. Root application change only.
