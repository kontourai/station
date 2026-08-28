// Compatibility command for callers that named the original single app.
// The manifest-driven generator is now the only implementation.
import { generateBasisMcpApps } from './generate-basis-mcp-apps.mjs';

await generateBasisMcpApps({ check: process.argv.includes('--check') });
