import { execFileSync } from 'node:child_process';

/**
 * Read `<revision>:<path>` objects in one `git cat-file --batch`; an absent
 * object (unknown revision or path) is undefined.
 * @param {string} root
 * @param {string[]} specs
 * @returns {(Buffer | undefined)[]}
 */
export function readGitObjects(root, specs) {
  if (!specs.length) return [];
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: specs.map((spec) => `${spec}\n`).join(''),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  return specs.map(() => {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString('utf8');
    offset = end + 1;
    if (/ (missing|ambiguous)$/.test(header)) return undefined;
    const size = Number(header.split(' ')[2]);
    const bytes = output.subarray(offset, offset + size);
    offset += size + 1;
    return bytes;
  });
}
