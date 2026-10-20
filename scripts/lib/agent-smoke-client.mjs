import { readFile } from 'node:fs/promises';

export function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

export function optionValues(name) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length))
    .filter(Boolean);
}

export async function readCredential() {
  if (process.env.STATION_CREDENTIAL) return process.env.STATION_CREDENTIAL;
  const path = optionValue('credential-file');
  if (!path) {
    throw new Error(
      'Provide STATION_CREDENTIAL or --credential-file=PATH|-; the credential is never printed.',
    );
  }
  if (path === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return (await readFile(path, 'utf8')).trim();
}

export function headers(credential, json = false) {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}
