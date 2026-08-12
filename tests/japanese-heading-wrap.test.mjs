import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const pages = [
  {
    file: 'src/pages/index.astro',
    phrases: [
      'ガソリンスタンドが、',
      '自動化の例を、',
      'noteにまとめています。',
      'つくって運営しています。',
      'まず、話を聞く',
    ],
  },
  {
    file: 'src/pages/personal.astro',
    phrases: [
      '自分の仕事に合う、',
      'AIの使い方を',
      'AIを業務改善に',
      'AIの使いどころを',
      '考えましょう。',
    ],
  },
];

test('日本語見出しは禁則処理とフレーズ単位の改行を使う', async () => {
  for (const page of pages) {
    const source = await readFile(path.join(projectRoot, page.file), 'utf8');

    assert.match(source, /line-break:\s*strict/);
    assert.match(source, /word-break:\s*auto-phrase/);
    assert.match(source, /\.title-line\s*\{[^}]*white-space:\s*nowrap/s);

    for (const phrase of page.phrases) {
      assert.ok(
        source.includes(`<span class="title-line">${phrase}</span>`),
        `${page.file}: 「${phrase}」を途中で改行しない指定がありません`,
      );
    }
  }
});
