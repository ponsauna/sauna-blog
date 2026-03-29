import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  // URLクエリパラメータを手動でパース
  const rawUrl = req.url || '';
  const queryString = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  const queryParams = Object.fromEntries(new URLSearchParams(queryString));

  // GETとPOST両方対応
  const params = { ...queryParams, ...(req.body || {}) };
  const secret = req.headers['x-webhook-secret'] || params.secret;

  if (secret !== process.env.WEBHOOK_SECRET?.trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { saunaUrl, notes, visitDate } = params;
    // saunaUrl: サウナイキタイのURL (例: https://sauna-ikitai.com/saunas/1234)
    // notes: ボイスメモから変換したテキスト
    // visitDate: YYYY-MM-DD (省略時は今日)

    // ── 0. サウナイキタイのページをスクレイピング ─────────────────────
    let saunaName = '';
    let saunaPageInfo = '';

    if (saunaUrl) {
      const pageRes = await fetch(saunaUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SaunaBot/1.0)' },
      });
      const html = await pageRes.text();

      // 施設名を取得（<title>タグまたはh1から）
      const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
                         html.match(/<title>([^|<]+)/);
      saunaName = titleMatch ? titleMatch[1].trim().replace(/\s*[\|｜].*$/, '').trim() : 'サウナ施設';

      // ページのテキスト情報を抽出（住所・料金など）
      const addressMatch = html.match(/住所[^>]*>([^<]{5,50})/);
      const priceMatch = html.match(/料金[^>]*>([^<]{3,30})/);
      if (addressMatch) saunaPageInfo += `住所: ${addressMatch[1].trim()}\n`;
      if (priceMatch) saunaPageInfo += `料金: ${priceMatch[1].trim()}\n`;
      saunaPageInfo += `参照URL: ${saunaUrl}`;
    } else if (notes) {
      // URLがない場合はノートからサウナ名を抽出
      const nameMatch = notes.match(/^(.{2,20}?(?:サウナ|温泉|スパ|SPA|SAUNA|風呂|銭湯)[^\s。、]*)/i) ||
                        notes.match(/([^\s。、]{2,20}(?:サウナ|温泉|スパ|SPA|SAUNA|風呂|銭湯)[^\s。、]*)/i);
      saunaName = nameMatch ? nameMatch[1].trim() : notes.split(/[。、\s]/)[0].trim() || 'サウナ施設';
    } else {
      saunaName = 'サウナ施設';
    }

    // 環境変数の余分な改行を除去
    const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
    const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID?.trim();
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
    const GITHUB_REPO = process.env.GITHUB_REPO?.trim();

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/cloud-platform',
      ],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const date = visitDate || new Date().toISOString().split('T')[0];

    // ── 1. Driveフォルダから最新のファイルを取得 ──────────────────────
    const filesRes = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      orderBy: 'createdTime desc',
      pageSize: 1,
      fields: 'files(id, name, webViewLink, mimeType)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const latestFile = filesRes.data.files?.[0];
    let driveLink = latestFile?.webViewLink || '';
    let ocrText = '';

    // ── 2. Vision API OCR（DriveファイルをダウンロードしてOCR）─────────
    if (latestFile) {
      const fileRes = await drive.files.get(
        { fileId: latestFile.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
      );
      const fileBase64 = Buffer.from(fileRes.data).toString('base64');
      const mimeType = latestFile.mimeType;

      const accessToken = await authClient.getAccessToken();
      const isPdf = mimeType === 'application/pdf';

      // PDFは files:annotate、画像は images:annotate を使う
      const visionEndpoint = isPdf
        ? 'https://vision.googleapis.com/v1/files:annotate'
        : 'https://vision.googleapis.com/v1/images:annotate';

      const visionBody = isPdf
        ? {
            requests: [{
              inputConfig: { content: fileBase64, mimeType: 'application/pdf' },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
              pages: [1],
            }],
          }
        : {
            requests: [{
              image: { content: fileBase64 },
              features: [{ type: 'TEXT_DETECTION' }],
            }],
          };

      const visionRes = await fetch(visionEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(visionBody),
      });
      const visionData = await visionRes.json();

      if (isPdf) {
        ocrText = visionData.responses?.[0]?.responses?.[0]?.fullTextAnnotation?.text || '';
      } else {
        ocrText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
      }
    }

    // ¥1,500 や 1500円 のような金額を抽出
    const amountMatch = ocrText.match(/[¥￥][\d,]+|[\d,]+円/);
    const rawAmount = amountMatch ? amountMatch[0].replace(/[¥￥円,]/g, '') : '';
    const displayAmount = rawAmount ? `¥${parseInt(rawAmount).toLocaleString()}` : '不明';

    // ── 3. Google Sheets に経費を記録 ────────────────────────────────
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A2:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          date,
          saunaName,
          displayAmount,
          driveLink,
        ]],
      },
    });

    // ── 4. Claude でブログ下書きを生成 ───────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
      }],
      messages: [{
        role: 'user',
        content: `あなたはサウナ専門のブロガーです。「${saunaName}」についてWeb検索で最新情報を調べてから、日本語のサウナブログ記事の下書きをMarkdown形式で生成してください。

サウナ名: ${saunaName}
訪問日: ${date}
サウナイキタイURL: ${saunaUrl || 'なし'}
取得済み情報: ${saunaPageInfo || 'なし'}
ユーザーの感想（ボイスメモ）: ${notes || 'なし'}

【重要】以下のフォーマットを厳守してください。frontmatterのdateはYYYY-MM-DD形式にしてください：

---
title: "${saunaName}の魅力を徹底解説【サウナレビュー】"
date: ${date}
category: "サウナレビュー"
coverImage: "/images/default-sauna.jpg"
excerpt: "（${saunaName}の特徴を1文で）"
---

## 基本情報

| 項目 | 内容 |
|---|---|
| 施設名 | ${saunaName} |
| 住所 | （Web検索で確認） |
| 営業時間 | （Web検索で確認） |
| 定休日 | （Web検索で確認） |
| 料金 | （Web検索で確認） |
| アクセス | （Web検索で確認） |

## 概要

（Web検索した施設の概要・特徴・歴史を200字程度で）

## サウナ室

（Web検索した温度・収容人数・ストーブの種類・特徴など）

## 水風呂

（Web検索した温度・深さ・水質・特徴など）

## 休憩スペース

（Web検索した外気浴・内気浴・チェア数・環境など）

## 料金・アクセス詳細

（Web検索した詳細な料金プラン・営業時間・アクセス方法）

## 私の感想

<!-- ここに感想を記入してください -->
<!-- ユーザーメモ: ${notes || 'なし'} -->

## まとめ

（まとめと総合評価）`,
      }],
    });

    // tool_use ブロックを除いてテキストだけ結合
    const blogContent = claudeRes.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // ── 5. GitHub PR を自動作成 ───────────────────────────────────────
    const slugBase = saunaName
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f-]/g, '');
    const timestamp = Date.now();
    const branchName = `blog/${date}-${slugBase}-${timestamp}`;
    const mdFileName = `${date}-${slugBase}.md`;

    const githubHeaders = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    const repoApi = `https://api.github.com/repos/${GITHUB_REPO}`;

    // mainブランチのSHAを取得
    const mainRes = await fetch(`${repoApi}/git/ref/heads/main`, { headers: githubHeaders });
    const mainData = await mainRes.json();
    const mainSha = mainData.object.sha;

    // 新しいブランチを作成
    await fetch(`${repoApi}/git/refs`, {
      method: 'POST',
      headers: githubHeaders,
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
    });

    // mdファイルをブランチに追加
    await fetch(`${repoApi}/contents/src/content/blog/${mdFileName}`, {
      method: 'PUT',
      headers: githubHeaders,
      body: JSON.stringify({
        message: `blog: ${saunaName}の記事を追加`,
        content: Buffer.from(blogContent).toString('base64'),
        branch: branchName,
      }),
    });

    // PRを作成
    const prRes = await fetch(`${repoApi}/pulls`, {
      method: 'POST',
      headers: githubHeaders,
      body: JSON.stringify({
        title: `📝 ${saunaName} 記事下書き (${date})`,
        body: `## ${saunaName}\n\n| 項目 | 内容 |\n|---|---|\n| 訪問日 | ${date} |\n| 金額 | ${displayAmount} |\n| レシート | [Google Drive](${driveLink}) |\n\n### 確認事項\n- [ ] 「私の感想」を記入\n- [ ] カバー画像を設定 (\`coverImage\`)\n- [ ] 施設情報の内容を確認・修正\n- [ ] タイトル・excerptを調整\n\n---\n*このPRはiOS Shortcutsから自動生成されました。*`,
        head: branchName,
        base: 'main',
      }),
    });
    const pr = await prRes.json();

    return res.status(200).json({
      success: true,
      driveLink,
      prUrl: pr.html_url,
      amount: displayAmount,
      receiptFile: latestFile?.name || 'なし',
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}
