import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  closeChildWorkload,
  execFileChildWorkload,
  ownWorkloadTransport,
  prepareChildWorkload,
  spawnChildWorkload,
} from '@kontourai/station-shared/child-workload';
import { createMCPTransport } from '@kontourai/station-shared/mcp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NodePtyAdapter } from '../../../../adapters/node-pty-adapter.js';
import { spawnOwnedChild, terminateProcessTree } from '../../process-utils.js';
import {
  initializeWorkloadResources,
  inspectWorkloadResources,
  stopWorkloadResources,
} from '../../workload-resources.js';

await initializeWorkloadResources();
if (process.argv[2] === 'unavailable-owner') {
  try {
    spawnOwnedChild(process.execPath, ['-e', 'process.exit(0)']);
    process.send?.({ blocked: false });
  } catch (error) {
    process.send?.({
      blocked: true,
      error: String(error),
      workloads: await inspectWorkloadResources(),
    });
  }
  process.exit(0);
}
if (process.argv[2] === 'orphan-owner') {
  const { proc } = spawnOwnedChild(process.execPath, [
    '-e',
    'console.log("ready");setInterval(()=>{},1000)',
  ]);
  await once(proc.stdout!, 'data');
  process.send?.({ pid: proc.pid });
  process.exit(0);
}
const held = new Map<number, ReturnType<typeof spawnChildWorkload>>();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/exec') {
      const result = await execFileChildWorkload(
        process.execPath,
        [
          '-e',
          'process.stdout.write(require("fs").readFileSync("/proc/self/cgroup","utf8"))',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      response.end(JSON.stringify(result));
      return;
    }
    if (url.pathname === '/mcp-handshake') {
      const observations = process.env.STATION_RESOURCE_PROOF_MCP_OBSERVATIONS;
      if (!observations) throw new Error('MCP observation path unavailable');
      const transport = createMCPTransport({
        id: 'resource-negotiation',
        kind: 'mcp',
        transport: 'stdio',
        command: process.execPath,
        args: [
          new URL('./workload-resource-mcp.mjs', import.meta.url).pathname,
          observations,
        ],
      });
      if (!transport) throw new Error('MCP transport unavailable');
      const client = new Client(
        { name: 'resource-proof', version: '1' },
        { versionNegotiation: { mode: 'auto' } },
      );
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: 'identity',
          arguments: {},
        });
        response.end(
          JSON.stringify({
            result,
            launches: (await readFile(observations, 'utf8'))
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line)),
            workloads: await inspectWorkloadResources(),
          }),
        );
      } finally {
        await client.close();
      }
      return;
    }
    if (url.pathname === '/mcp') {
      const script =
        'const {spawn}=require("node:child_process");process.stdin.once("data",()=>{const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore",1,2],windowsHide:true});c.unref();console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{descendant:c.pid}}));setTimeout(()=>process.exit(0),50)})';
      const launch = url.searchParams.has('legacy')
        ? prepareChildWorkload(process.execPath, ['-e', script])
        : undefined;
      const transport = launch
        ? ownWorkloadTransport(
            new StdioClientTransport({
              command: launch.command,
              args: launch.args,
              env: Object.fromEntries(
                Object.entries(launch.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
            }),
            launch,
          )
        : createMCPTransport({
            id: 'resource-proof',
            kind: 'mcp',
            transport: 'stdio',
            command: process.execPath,
            args: ['-e', script],
          });
      if (!transport) throw new Error('MCP transport unavailable');
      const reply = new Promise<unknown>((resolve, reject) => {
        transport.onmessage = resolve;
        transport.onerror = reject;
      });
      await transport.start();
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'proof' });
      const message = await reply;
      // Leave inherited stdout open until the resource owner observes leader exit.
      response.end(JSON.stringify(message));
      return;
    }
    if (url.pathname === '/unavailable') {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', import.meta.filename, 'unavailable-owner'],
        {
          env: { ...process.env, STATION_WORKLOAD_MEMORY_MIB: 'invalid' },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true,
        },
      );
      const [message] = await once(child, 'message');
      await once(child, 'exit');
      response.end(JSON.stringify(message));
      return;
    }
    if (url.pathname === '/aggregate') {
      await Promise.all(
        Array.from({ length: 7 }, async () => {
          const { proc } = spawnOwnedChild(process.execPath, [
            '-e',
            'global.b=Buffer.alloc(36*1048576,7);console.log("ready");setInterval(()=>{},1000)',
          ]);
          held.set(proc.pid!, proc);
          await Promise.race([once(proc.stdout!, 'data'), once(proc, 'exit')]);
        }),
      );
      response.end(JSON.stringify(await inspectWorkloadResources()));
      return;
    }
    if (url.pathname === '/orphan') {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', import.meta.filename, 'orphan-owner'],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
      );
      const [message] = await once(child, 'message');
      await once(child, 'exit');
      response.end(JSON.stringify(message));
      return;
    }
    if (url.pathname === '/reap') {
      await initializeWorkloadResources();
      response.end('reaped');
      return;
    }
    if (url.pathname === '/status') {
      response.end(
        JSON.stringify({
          pid: process.pid,
          cgroup: await readFile('/proc/self/cgroup', 'utf8'),
          workloads: await inspectWorkloadResources(),
        }),
      );
      return;
    }
    if (url.pathname === '/terminal') {
      const modulePath = process.env.STATION_RESOURCE_PROOF_PTY_MODULE;
      const adapter = modulePath
        ? new NodePtyAdapter(() => import(pathToFileURL(modulePath).href))
        : new NodePtyAdapter();
      const terminal = await adapter.spawn({
        shell: '/bin/bash',
        args: ['--noprofile', '--norc'],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: { PATH: process.env.PATH, PS1: 'station-proof> ' },
      });
      let output = '';
      const waitFor = (value: string) =>
        new Promise<void>((resolve, reject) => {
          let pendingOutput = '';
          const timeout = setTimeout(() => {
            dispose();
            reject(new Error(`Terminal missing ${value}: ${output}`));
          }, 3000);
          const dispose = terminal.onData((data) => {
            output += data;
            pendingOutput += data;
            if (pendingOutput.includes(value)) {
              clearTimeout(timeout);
              dispose();
              resolve();
            }
          });
        });
      try {
        terminal.resize(101, 37);
        const ready = waitFor('__PROOF_READY__');
        terminal.write(
          'stty size; cat /proc/self/cgroup; cd /; /bin/sh -c \'printf "__PROOF_%s__\\n" READY; exec sleep 30\'\r',
        );
        await ready;
        if (!terminal.getCwd)
          throw new Error('Terminal cwd inspection unavailable');
        const cwd = await terminal.getCwd();
        const interrupted = waitFor('station-proof> ');
        terminal.write('\x03');
        await interrupted;
        const resumed = waitFor('__PROOF_RESUMED__');
        terminal.write("printf '__PROOF_%s__\\n' RESUMED\r");
        await resumed;
        response.end(JSON.stringify({ pid: terminal.pid, cwd, output }));
      } finally {
        terminal.kill();
      }
      return;
    }
    if (url.pathname === '/terminal-grace') {
      const modulePath = process.env.STATION_RESOURCE_PROOF_PTY_MODULE;
      const adapter = modulePath
        ? new NodePtyAdapter(() => import(pathToFileURL(modulePath).href))
        : new NodePtyAdapter();
      const terminal = await adapter.spawn({
        shell: process.execPath,
        args: [
          '-e',
          'process.on("SIGHUP",()=>setTimeout(()=>{console.log("flushed");process.exit(0)},200));console.log("ready");setInterval(()=>{},1000)',
        ],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: { PATH: process.env.PATH },
      });
      let output = '';
      await new Promise<void>((resolve) => {
        const dispose = terminal.onData((data) => {
          if (data.includes('ready')) {
            dispose();
            resolve();
          }
        });
      });
      const exited = new Promise<void>((resolve) =>
        terminal.onExit(() => resolve()),
      );
      terminal.onData((data) => {
        output += data;
      });
      terminal.kill();
      await exited;
      response.end(JSON.stringify({ output }));
      return;
    }
    if (url.pathname === '/graceful') {
      const { proc } = spawnOwnedChild(process.execPath, [
        '-e',
        'process.on("SIGTERM",()=>{console.log("graceful");process.exit(0)});console.log("ready");setInterval(()=>{},1000)',
      ]);
      await once(proc.stdout!, 'data');
      let output = '';
      proc.stdout!.on('data', (chunk) => {
        output += chunk;
      });
      await terminateProcessTree(proc);
      response.end(JSON.stringify({ output, code: proc.exitCode }));
      return;
    }
    if (url.pathname === '/close') {
      const pid = Number(url.searchParams.get('pid'));
      held.get(pid)?.kill('SIGKILL');
      await closeChildWorkload(pid);
      held.delete(pid);
      response.end('closed');
      return;
    }
    const mode = url.searchParams.get('mode') ?? 'echo';
    const script =
      mode === 'oom'
        ? 'process.stdout.write("ready\\n");process.stdin.once("data",()=>Buffer.alloc(128*1048576,7))'
        : mode === 'escape'
          ? 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),50)'
          : mode === 'ipc'
            ? 'process.send({pid:process.pid,ok:true});process.exit(0)'
            : mode === 'fds'
              ? 'require("node:fs").writeSync(3,"fd3");require("node:fs").writeSync(4,"fd4")'
              : 'const fs=require("node:fs");console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(1),cgroup:fs.readFileSync("/proc/self/cgroup","utf8"),env:process.env}));process.stdin.on("data",d=>process.stdout.write(d))';
    if (mode === 'ipc') {
      const child = spawnChildWorkload(process.execPath, ['-e', script], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH },
        detached: true,
      });
      const [message] = await once(child, 'message');
      await once(child, 'close');
      response.end(JSON.stringify(message));
      return;
    }
    if (mode === 'fds') {
      const child = spawnChildWorkload(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
      let output = '';
      for (const stream of [child.stdio[3], child.stdio[4]]) {
        if (stream && 'on' in stream)
          stream.on('data', (data) => {
            output += data;
          });
      }
      const [code] = await once(child, 'close');
      response.end(JSON.stringify({ code, output }));
      return;
    }
    const { proc: child } = spawnOwnedChild(
      process.execPath,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: argv must retain literal shell expansions.
      ['-e', script, 'literal $HOME ${PATH} $(false)'],
      {
        env: { PATH: process.env.PATH, FIXTURE_VALUE: 'exact $HOME' },
      },
    );
    held.set(child.pid!, child);
    let output = '';
    child.stderr?.on('data', (data) => {
      output += data;
    });
    const first = await new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', (chunk) => resolve(String(chunk)));
      child.once('exit', (code) =>
        reject(new Error(`Workload exited before ready: ${code}: ${output}`)),
      );
    });
    if (mode === 'oom') {
      const exit = once(child, 'exit');
      child.stdin!.write('go');
      const [code, signal] = await exit;
      await closeChildWorkload(child.pid);
      response.end(
        JSON.stringify({
          first,
          code,
          signal,
          workloads: await inspectWorkloadResources(),
        }),
      );
    } else if (mode === 'escape') {
      await once(child, 'exit');
      await closeChildWorkload(child.pid);
      response.end(JSON.stringify({ escapedPid: Number(first) }));
    } else {
      response.end(
        JSON.stringify({ pid: child.pid, first: JSON.parse(first) }),
      );
    }
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => {
  void stopWorkloadResources().finally(() =>
    server.close(() => process.exit(0)),
  );
});
