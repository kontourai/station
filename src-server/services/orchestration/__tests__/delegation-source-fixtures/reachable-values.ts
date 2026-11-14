import { randomUUID } from 'node:crypto';
import type { Runtime } from 'node:inspector';
import { Session } from 'node:inspector/promises';

/** Inspect plain data and lexical closures, excluding host instances and global/module roots. */
export async function findReachableString(
  owner: object,
  needle: string,
): Promise<readonly string[] | null> {
  const key = `stationReachability${randomUUID()}`;
  const session = new Session();
  Object.defineProperty(globalThis, key, {
    value: { owner, seen: new WeakSet<object>() },
    configurable: true,
  });
  session.connect();
  try {
    const root = await session.post('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(key)}].owner`,
      objectGroup: key,
    });
    const pending: Array<{ value: Runtime.RemoteObject; path: string[] }> = [
      { value: root.result, path: [] },
    ];
    let inspected = 0;
    while (pending.length) {
      const next = pending.shift();
      if (!next) throw Error('Missing reachability node');
      const { value, path } = next;
      if (value.type === 'string' && String(value.value).includes(needle))
        return path;
      if (!value.objectId) continue;
      const description = value.description ?? '';
      if (/^(Global|Module|Script)(?:$|\s)/.test(description)) continue;
      const scope = /^(Scopes\[|Closure|Block|Local|Catch|With)(?:\b|\[)/.test(
        description,
      );
      if (
        value.type === 'object' &&
        !scope &&
        description !== 'Object' &&
        value.subtype !== 'array'
      )
        continue;
      if (++inspected > 1024) throw Error('Owner reachability bound exceeded');
      if (!scope) {
        const seen = await session.post('Runtime.callFunctionOn', {
          objectId: value.objectId,
          functionDeclaration: `function (key) {
            const seen = globalThis[key].seen;
            if (seen.has(this)) return true;
            seen.add(this);
            return false;
          }`,
          arguments: [{ value: key }],
          returnByValue: true,
        });
        if (seen.exceptionDetails)
          throw Error('Owner reachability identity unavailable');
        if (seen.result.value === true) continue;
      }
      const properties = await session.post('Runtime.getProperties', {
        objectId: value.objectId,
        ownProperties: true,
      });
      if (properties.exceptionDetails)
        throw Error('Owner reachability properties unavailable');
      for (const property of properties.result) {
        if (
          property.value &&
          !['constructor', 'prototype', '__proto__'].includes(property.name)
        )
          pending.push({
            value: property.value,
            path: [...path, property.name],
          });
      }
      for (const property of properties.internalProperties ?? []) {
        if (
          property.value &&
          ['[[Scopes]]', '[[Entries]]'].includes(property.name)
        )
          pending.push({
            value: property.value,
            path: [...path, property.name],
          });
      }
    }
    return null;
  } finally {
    await session.post('Runtime.releaseObjectGroup', { objectGroup: key });
    session.disconnect();
    Reflect.deleteProperty(globalThis, key);
  }
}
