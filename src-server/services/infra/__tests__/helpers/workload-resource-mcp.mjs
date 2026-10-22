import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// Each physical process leaves a pipe-holding descendant, including the probe.
const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  detached: true,
  stdio: ['ignore', 1, 2],
  windowsHide: true,
});
descendant.unref();
const handle = serveStdio(
  () => {
    const server = new McpServer({ name: 'resource-proof', version: '1' });
    server.registerTool('identity', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'identity' }],
      structuredContent: {
        pid: process.pid,
        descendant: descendant.pid,
        cgroup: readFileSync('/proc/self/cgroup', 'utf8'),
      },
    }));
    return server;
  },
  { legacy: 'serve' },
);
process.stdin.on('end', () => {
  void handle.close().finally(() => process.exit(0));
});
