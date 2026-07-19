import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { saunaName, visitDate, saunaIkitaiUrl, photoCaptions = [], comment = '' } = req.body;
    if (!saunaName?.trim()) return res.status(400).json({ error: '施設名が必要です' });

    const date = visitDate || new Date().toISOString().split('T')[0];
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() });

    const photoInfo = photoCaptions.length > 0
      ? photoCaptions.map((c, i) => `写真${i + 1}: ${c}`).join('\n')
      : '';

    const prompt = `あなたはサウナ専門のブロガーです。以下の情報をもとに、日本語のサウナブログ記事の下書きをMarkdown形式で生成してください。

施設名: ${saunaName}
訪問日: ${date}
サウナイキタイURL: ${saunaIkitaiUrl || '（なし）'}
${photoInfo ? `\n写真の説明:\n${photoInfo}` : ''}
${comment ? `\nユーザーのコメント:\n${comment}` : ''}

${saunaIkitaiUrl ? `まず「${saunaIkitaiUrl}」のページをWeb検索で参照して施設情報を取得してください。` : `「${saunaName} サウナ」でWeb検索して施設情報を調べてください。`}

【必須フォーマット】以下の構造でMarkdownを生成してください：

---
title: "${saunaName}の魅力を徹底解説！【サウナレビュー】"
date: ${date}
category: "サウナレビュー"
coverImage: "/images/posts/SLUG/cover.jpg"
excerpt: "（${saunaName}の特徴を1文で）"
rating: 5
facilityName: "${saunaName}"
---

## 基本情報

| 項目 | 内容 |
|---|---|
| 施設名 | ${saunaName} |
| 住所 | （調査した住所） |
| 営業時間 | （調査した営業時間） |
| 定休日 | （調査した定休日） |
| 料金 | （調査した料金） |
| アクセス | （調査したアクセス） |

## 概要

（施設のコンセプト・特徴を200字程度で）

## サウナ室

（温度・ストーブ・ロウリュ・雰囲気など。ユーザーコメントがあれば反映）

## 水風呂

（温度・深さ・特徴など。ユーザーコメントがあれば反映）

## 休憩スペース

（外気浴・内気浴・チェア・環境など。ユーザーコメントがあれば反映）

## 料金・アクセス詳細

（詳細な料金プランとアクセス情報）

## 私の感想

${comment ? `（以下のユーザーコメントをもとに自然な感想文を書く）\n<!-- ユーザーコメント: ${comment} -->` : '<!-- 感想を追記してください -->'}

## まとめ

（総括と総合評価）

**総合評価：⭐⭐⭐⭐（X/5）**

---`;

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    const draft = claudeRes.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ draft });
  } catch (err) {
    console.error('generate-post:', err);
    return res.status(500).json({ error: err.message });
  }
}
