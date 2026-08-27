import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const probe = `
import {controlRequestOptions,INTERNAL_CONTROL_CALLER_BINDING_HEADER,withStationControlCallerBinding} from './src-server/tools/station-control-shared.ts';
const read=()=>controlRequestOptions().headers[INTERNAL_CONTROL_CALLER_BINDING_HEADER];
const first=read();
const again=read();
const override=await withStationControlCallerBinding('verified_http_binding'.padEnd(32,'a'),async()=>{await Promise.resolve();return read();});
console.log(JSON.stringify({first,again,override,restored:read()}));
`;

test('independent stdio processes sharing an internal credential have distinct stable caller bindings', async () => {
  const outputs = await Promise.all(
    [0, 1].map(async () => {
      const result = await run(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', probe],
        {
          cwd: root,
          env: {
            ...process.env,
            STATION_INTERNAL_API_TOKEN: 'fixture-internal-token',
            STATION_INTERNAL_TENANT: 'fixture-tenant',
          },
          timeout: 20_000,
          maxBuffer: 4096,
          windowsHide: true,
        },
      );
      return JSON.parse(result.stdout) as {
        first: string;
        again: string;
        override: string;
        restored: string;
      };
    }),
  );
  for (const output of outputs) {
    expect(output.first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(output.again).toBe(output.first);
    expect(output.restored).toBe(output.first);
    expect(output.override).toBe('verified_http_binding'.padEnd(32, 'a'));
  }
  expect(outputs[0]!.first).not.toBe(outputs[1]!.first);
}, 30_000);
