---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-shared": minor
---

Remove exports that had no consumer. Import the replacements where one exists.

- Shared: remove the `./guidance-assets`, `./agent-validation` and
  `./mcp-elicitation-form` subpaths and the root re-exports of
  `skillToGuidanceAsset`, `requiresAgentPrompt` and
  `requiresAgentPromptForRuntime`. Use
  `@kontourai/station-contracts/guidance-assets` (its copy also keeps the
  skill's `provenance`, which the shared copy dropped) and
  `@kontourai/station-contracts/agent-validation`. Read MCP elicitations with
  `inputRequestFromRequestEvent` from `@kontourai/station-shared/input-request`.
- Contracts: remove `McpElicitationForm`, which only the removed shared reader
  returned. The field types stay.
- SDK: remove the unused `KeyboardCommand`, `WindowOptions` and
  `IKnowledgeProvider` types; the `./answer-narrative-binding` subpath
  (`getAnswerNarrativeTarget`, `publishAnswerNarrative`,
  `removeAnswerNarrative`, `AnswerNarrativeBindingRequestError`);
  `useSecretBindingQuery`; `useSessionOutputsQuery` and
  `sessionOutputsQueries`; `useKeepDeclaredOutputMutation` and
  `keepDeclaredOutput` (use `useKeepSessionOutputMutation` from
  `./session-output-actions`); and `useInvalidateSessionInventory`.
