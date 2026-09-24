---
'@kontourai/station-sdk': minor
---

Type the host context hooks and knowledge results (#2399, #2400).

- `useAgents`, `useNavigation`, `useToast` and `useAuth` now return the
  published `AgentSummary[]`, `SDKNavigation`, `SDKToast` and `SDKAuthState`
  contracts instead of `any`. Code that read members outside a contract stops
  compiling. `SDKNavigation` does not expose these host navigation members:
  `updateParams`, `setAgent`, `setDockMode`, `collapseMaximizedDock`,
  `dockMode`, `selectedLayout`, `activeWorkspacePane` and `fontSize`.
- `SDKContextValue`'s `agents`, `navigation`, `toast` and `auth` slots are
  typed by `SDKAgentsContext`, `SDKNavigationContext`, `SDKToastContext` and
  `SDKAuthContext`, so a host must satisfy them.
- `showToast` accepts `(message, type?, duration?)` or a `ToastRequest` object,
  which now also takes `actions`.
- The knowledge tree, document list, filtered list and namespace queries return
  `KnowledgeTreeNode`, `KnowledgeDocumentMeta[]` and
  `KnowledgeNamespaceConfig[]`; `KnowledgeTreeNode` and `KnowledgeSearchFilter`
  are exported. `AgentSummary` gains an optional `plugin`.
- `useSendToChat` widens to accept a plugin-qualified `'<plugin>:<agent>'`
  reference as well as an `AgentId`; it sends only when the named plugin
  contributed that Agent. `AgentId` and `QualifiedPluginAgentId` are exported.
- Fix: `useDockState` read a `dockState` field the host never provided, so
  `isOpen` was always false; it now reads `isDockOpen`.
- `NavigationState` is deprecated in favour of `SDKNavigation`.
