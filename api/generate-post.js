import Anthropic from '@anthropic-ai/sdk';

const QUESTIONS = [
  'サウナ室はどうでしたか？',
  '水風呂はどうでしたか？',
  '外気浴・休憩スペースはどうでしたか？',
  '混み具合・滞在時間は？',
  '全体的な感想・おすすめポイントは？',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { saunaName, visitDate, answers = {}, images = [] } = req.body;

    if (!saunaName?.trim()) {
      return res.status(400).json({ error: '施設名を入力してください' });
    }

    const date = visitDate || new Date().toISOString().split('T')[0];
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
    const GITHUB_REPO = process.env.GITHUB_REPO?.trim();

    const slug = saunaName.trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w　-鿿゠-ヿ぀-ゟ-]/g, '');

    const notesText = QUESTIONS
      .map((q, i) => {
        const a = answers[`q${i + 1}`]?.trim();
        return a ? `【${q}】\n${a}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    const coverImagePath = images.length > 0
      ? `/images/posts/${slug}/01.jpg`
      : '/images/default-sauna.jpg';

    // --- Generate blog with Claude ---
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() });

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `あなたはサウナ専門のブロガーです。「${saunaName}」をサウナイキタイ（sauna-ikitai.com）および公式サイトでWeb検索して最新情報を調べてから、日本語のサウナブログ記事の下書きをMarkdown形式で生成してください。

サウナ名: ${saunaName}
訪問日: ${date}

ユーザーの回答:
${notesText || '（なし）'}

【必須フォーマット】以下をそのまま使い、（）内を実際の情報に置き換えてください：

---
title: "${saunaName}の魅力を徹底解説！【サウナレビュー】"
date: ${date}
category: "サウナレビュー"
coverImage: "${coverImagePath}"
excerpt: "（${saunaName}の特徴を1文で。Web検索結果をもとに）"
---

## 基本情報

| 項目 | 内容 |
|---|---|
| 施設名 | ${saunaName} |
| 住所 | （Web検索で確認した住所） |
| 営業時間 | （Web検索で確認した営業時間） |
| 定休日 | （Web検索で確認した定休日） |
| 料金 | （Web検索で確認した料金） |
| アクセス | （Web検索で確認したアクセス方法） |

## 概要

（Web検索した施設の概要・コンセプト・特徴を200字程度で）

## サウナ室

（温度・収容人数・ストーブ・ロウリュ・雰囲気など。ユーザー回答があれば反映）

## 水風呂

（温度・深さ・水質・特徴など。ユーザー回答があれば反映）

## 休憩スペース

（外気浴・内気浴・チェア・環境など。ユーザー回答があれば反映）

## 料金・アクセス詳細

（詳細な料金プランと営業時間・アクセス方法）

## 私の感想

（ユーザーの回答をもとに自然な感想文を書く。回答がない場合は「<!-- 感想を追記してください -->」と書く）

## まとめ

（${saunaName}の総括と評価）

**総合評価：⭐⭐⭐⭐（X/5）**

---`,
      }],
    });

    const blogContent = claudeRes.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // --- GitHub PR ---
    const mdFileName = `${date}-${slug}.md`;
    const branchName = `blog/${date}-${slug}-${Date.now()}`;

    const githubHeaders = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    const repoApi = `https://api.github.com/repos/${GITHUB_REPO}`;

    const mainRef = await fetch(`${repoApi}/git/ref/heads/main`, { headers: githubHeaders });
    const mainData = await mainRef.json();
    const mainSha = mainData.object?.sha;
    if (!mainSha) throw new Error('mainブランチのSHA取得失敗: ' + JSON.stringify(mainData));

    await fetch(`${repoApi}/git/refs`, {
      method: 'POST',
      headers: githubHeaders,
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
    });

    await fetch(`${repoApi}/contents/src/content/blog/${mdFileName}`, {
      method: 'PUT',
      headers: githubHeaders,
      body: JSON.stringify({
        message: `blog: ${saunaName}の記事を追加`,
        content: Buffer.from(blogContent).toString('base64'),
        branch: branchName,
      }),
    });

    for (let i = 0; i < Math.min(images.length, 5); i++) {
      const imgNum = String(i + 1).padStart(2, '0');
      await fetch(`${repoApi}/contents/public/images/posts/${slug}/${imgNum}.jpg`, {
        method: 'PUT',
        headers: githubHeaders,
        body: JSON.stringify({
          message: `images: ${saunaName}の写真を追加`,
          content: images[i],
          branch: branchName,
        }),
      });
    }

    const prChecklist = [
      '- [ ] 「私の感想」を確認・修正',
      images.length > 0
        ? `- [ ] カバー画像は自動追加済み（\`${coverImagePath}\`）`
        : `- [ ] カバー画像を追加（\`public/images/posts/${slug}/\`）`,
      '- [ ] 施設情報（住所・料金など）を確認・修正',
      '- [ ] タイトル・excerptを調整',
    ].join('\n');

    const prRes = await fetch(`${repoApi}/pulls`, {
      method: 'POST',
      headers: githubHeaders,
      body: JSON.stringify({
        title: `📝 ${saunaName} 記事下書き (${date})`,
        body: `## ${saunaName}\n\n訪問日: ${date}\n\n### 確認事項\n${prChecklist}\n\n---\n*管理ページから自動生成*`,
        head: branchName,
        base: 'main',
      }),
    });
    const pr = await prRes.json();

    return res.status(200).json({
      success: true,
      prUrl: pr.html_url,
      draft: blogContent,
    });

  } catch (err) {
    console.error('generate-post error:', err);
    return res.status(500).json({ error: err.message });
  }
}
