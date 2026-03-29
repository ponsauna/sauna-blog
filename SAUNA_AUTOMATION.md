# サウナブログ自動化システム ドキュメント

## 概要

サウナ訪問後、iOSショートカットを1タップするだけでGoogle Sheetsへの経費記録・ブログ下書き生成・GitHub PRの作成まで自動で行われるシステム。

---

## 技術スタック

| カテゴリ | サービス | 用途 |
|---|---|---|
| フロントエンド | Astro | 静的サイト生成 |
| ホスティング | Vercel | デプロイ・サーバーレス関数 |
| AI | Anthropic Claude (Haiku) | ブログ下書き生成・Web検索 |
| OCR | Google Cloud Vision API | レシート金額の読み取り |
| ストレージ | Google Drive | レシート写真の保管 |
| 経費管理 | Google Sheets | 訪問日・店舗名・金額の記録 |
| ソース管理 | GitHub | ブログ記事の管理・PR作成 |
| 認証 | Google Service Account | Google API認証 |
| トリガー | iOS Shortcuts | ワークフローの起動 |

---

## 1記事あたりのコスト

| サービス | 料金 | 備考 |
|---|---|---|
| Claude Haiku API | 約3〜5円 | 入力2,000トークン＋出力4,000トークン |
| Web検索 (Claude tool) | 約1〜2円 | 1回の検索 |
| Google Vision API | 0円 | 月1,000件まで無料 |
| Google Sheets API | 0円 | 無料 |
| Google Drive API | 0円 | 無料 |
| GitHub API | 0円 | 無料 |
| Vercel | 0円 | Hobbyプラン無料枠内 |
| **合計** | **約5〜8円/記事** | |

> 月10記事書いても約50〜80円。実質ほぼ無料。

---

## 更新フロー（1記事の流れ）

### サウナ当日

```
1. サウナへ行く
2. レシートをもらう
3. レシートを写真に撮り Google Drive の「サウナ」フォルダにアップロード
4. iOSショートカットを起動
   - サウナイキタイのURLを入力（または省略）
   - ボイスメモで感想を話す（テキストに自動変換）
5. 送信ボタンをタップ → 完了（10〜30秒）
```

### 自動処理（バックグラウンド）

```
webhook受信
  ↓
Google Drive から最新レシート取得
  ↓
Vision API で金額OCR読み取り
  ↓
Google Sheets に記録（日付・店舗名・金額・Drive URL）
  ↓
Claude Haiku がWeb検索して施設情報を調査
  ↓
ブログ下書きをMarkdownで生成
  ↓
GitHub にブランチ作成 → mdファイルを追加 → PR作成
```

### PR確認・公開

```
6. GitHubのPRを開く
7. Files changed で内容を確認
8. 必要に応じて「私の感想」を編集
9. Canvaで作ったサムネをアップロード（任意）
   → public/images/posts/ に配置
   → frontmatterの coverImage を更新
10. Merge pull request
    ↓
    Vercelが自動ビルド・デプロイ
    ↓
    ブログに公開 🎉
```

---

## 環境変数一覧

| 変数名 | 内容 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API キー |
| `GITHUB_TOKEN` | GitHub Personal Access Token |
| `GITHUB_REPO` | リポジトリ名（例: ponsauna/sauna-blog） |
| `GOOGLE_SPREADSHEET_ID` | スプレッドシートID |
| `GOOGLE_DRIVE_FOLDER_ID` | レシート保管フォルダID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウントのJSONキー |
| `WEBHOOK_SECRET` | ショートカット認証用シークレット |

> Vercelのダッシュボード → Settings → Environment Variables で管理

---

## Google Sheets 構造

| A列 | B列 | C列 | D列 |
|---|---|---|---|
| 日付 | 店舗名 | 金額 | Google Drive リンク |
| 2026-03-29 | 渋谷SAUNAS | ¥3,500 | https://drive.google.com/... |

---

## ブログ記事 構造

```
src/content/blog/
  └── 2026-03-29-渋谷SAUNAS.md   ← 自動生成
```

```yaml
---
title: "渋谷SAUNASの魅力を徹底解説【サウナレビュー】"
date: 2026-03-29
category: "サウナレビュー"
coverImage: "/images/posts/渋谷SAUNAS/cover.jpg"
excerpt: "施設の特徴を1文で"
---
```

---

## サムネ画像の追加方法

1. Canvaでデザインを作成・JPGでダウンロード
2. GitHub → `public/images/posts/施設名/` にアップロード
3. 記事mdファイルの `coverImage` を更新してcommit

---

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `api/webhook.js` | 自動化のメイン処理（Vercelサーバーレス関数） |
| `vercel.json` | Vercel設定（maxDuration: 60秒） |
| `src/content/blog/` | ブログ記事のMarkdownファイル |
| `public/images/posts/` | 記事のサムネ画像 |
