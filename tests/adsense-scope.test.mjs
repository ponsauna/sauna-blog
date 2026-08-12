import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = path.join(projectRoot, 'dist');
const adSenseLoader = 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? findHtmlFiles(entryPath)
      : entry.name.endsWith('.html') ? [entryPath] : [];
  }));

  return files.flat();
}

test('AdSenseはサウナブログだけで読み込む', async () => {
  const htmlFiles = await findHtmlFiles(distDir);
  const blogFiles = htmlFiles.filter((file) => (
    path.relative(distDir, file).startsWith(`blog${path.sep}`)
  ));
  const nonBlogFiles = htmlFiles.filter((file) => !blogFiles.includes(file));

  assert.ok(blogFiles.length > 0, 'サウナブログの生成ページがありません');

  for (const file of blogFiles) {
    const html = await readFile(file, 'utf8');
    assert.ok(html.includes(adSenseLoader), `${path.relative(distDir, file)} にAdSenseがありません`);
  }

  for (const file of nonBlogFiles) {
    const html = await readFile(file, 'utf8');
    assert.ok(!html.includes(adSenseLoader), `${path.relative(distDir, file)} でAdSenseを読み込んでいます`);
  }
});
