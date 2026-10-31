import { findFreePortBlock, findFreePortOutside } from './free-ports.mjs';

const RESERVED_PORTS = new Set([3000, 3141, 18141, 28141, 38141, 38000]);

/** Choose a free block and UI port without touching a Station default port. */
export async function choosePortableSmokePorts() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const serverPort = await findFreePortBlock(4);
    const block = [0, 1, 2, 3].map((offset) => serverPort + offset);
    if (block.some((port) => RESERVED_PORTS.has(port))) continue;
    const uiPort = await findFreePortOutside(serverPort, 4);
    if (RESERVED_PORTS.has(uiPort)) continue;
    return { serverPort, uiPort };
  }
  throw new Error('unable to allocate non-reserved portable smoke ports');
}
