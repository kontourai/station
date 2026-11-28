import { expect } from 'vitest';

export function windowsTrustOperation(
  args: string[],
): 'ensure' | 'verify' | null {
  const program = Buffer.from(args[3] ?? '', 'base64').toString('utf16le');
  const payload = /\$request = .*FromBase64String\('([^']+)'\)/u.exec(
    program,
  )?.[1];
  if (payload === undefined) return null;
  const request = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  if (!Object.hasOwn(request, 'operation')) return null;
  expect(request).toEqual({
    operation: expect.stringMatching(/^(ensure|verify)$/u),
    targets: expect.any(Array),
  });
  expect(request.targets.length).toBeGreaterThan(0);
  for (const target of request.targets) {
    expect(target).toEqual({
      kind: expect.stringMatching(/^(directory|file)$/u),
      path: expect.stringMatching(/\S/u),
      policy: expect.stringMatching(/^(current-user-only|execution-safe)$/u),
    });
  }
  return request.operation;
}
