import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTML_REPLY_LIMITS } from '@kontourai/station-contracts/html-reply';
import { afterEach, describe, expect, test } from 'vitest';
import { prepareHtmlReply } from '../html-replies.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'html-reply-'));
  roots.push(root);
  const image = join(root, 'chart.png');
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(image, bytes);
  return { root, image, bytes };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('HTML reply preparation', () => {
  test('captures image bytes in attributes, CSS and script literals before originals are deleted', async () => {
    const { root, image, bytes } = await fixture();
    const page = await prepareHtmlReply(
      {
        html: `<img src="${image}"><style>div{background:url('${image}')}</style><script>const image="${image}";</script>`,
        height: 400,
      },
      root,
    );
    await rm(image);
    const data = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(page).toEqual({
      version: 1,
      height: 400,
      html: `<img src="${data}"><style>div{background:url('${data}')}</style><script>const image="${data}";</script>`,
    });
  });
  test('rejects over-limit source by bytes, invalid height, oversized image, and non-image content', async () => {
    const { root, image } = await fixture();
    await expect(
      prepareHtmlReply(
        {
          html: 'é'.repeat(HTML_REPLY_LIMITS.sourceBytes / 2 + 1),
          height: 400,
        },
        root,
      ),
    ).rejects.toThrow('source exceeds');
    await expect(
      prepareHtmlReply({ html: '', height: 99 }, root),
    ).rejects.toThrow('height');
    await writeFile(image, Buffer.alloc(HTML_REPLY_LIMITS.imageBytes + 1));
    await expect(
      prepareHtmlReply({ html: `<img src="${image}">`, height: 400 }, root),
    ).rejects.toThrow('image exceeds');
    await writeFile(image, 'a secret disguised as an image');
    await expect(
      prepareHtmlReply({ html: `<img src="${image}">`, height: 400 }, root),
    ).rejects.toThrow('must be PNG');
  });
  test('rejects total expanded size rather than truncating repeated images', async () => {
    const { root, image, bytes } = await fixture();
    await writeFile(image, Buffer.concat([bytes, Buffer.alloc(1024 * 1024)]));
    await expect(
      prepareHtmlReply(
        { html: `<img src="${image}">`.repeat(8), height: 400 },
        root,
      ),
    ).rejects.toThrow('page exceeds');
  });
  test('refuses symlinks escaping the authorized image root and missing files', async () => {
    const inside = await fixture();
    const outside = await fixture();
    const link = join(inside.root, 'outside.png');
    await symlink(outside.image, link);
    await expect(
      prepareHtmlReply(
        { html: `<img src="${link}">`, height: 400 },
        inside.root,
      ),
    ).rejects.toThrow('outside the authorized');
    await expect(
      prepareHtmlReply(
        {
          html: `<img src="${join(inside.root, 'missing.png')}">`,
          height: 400,
        },
        inside.root,
      ),
    ).rejects.toThrow();
  });
});
