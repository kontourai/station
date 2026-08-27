# Render MCP-UI in an open hardened host

Station renders MCP-UI resources as an open host rather than only allowing pre-trusted Kontour panels. The decision is to contain hostile or unknown panels with sandboxing, origin isolation, host-built policy, and approval-mediated tool calls, because MCP-UI is a distribution standard and Station should be a strong host for any compliant server without granting implicit trust.
