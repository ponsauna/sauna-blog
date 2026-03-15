# Astro ブログ

Astro + Tailwind CSS で構築した日本語ブログサイトです。

## 技術スタック

| 項目 | 詳細 |
|------|------|
| フレームワーク | Astro v5 |
| スタイル | Tailwind CSS v3 |
| 記事管理 | Astro Content Collections |
| フォント | Noto Sans JP (Google Fonts) |

## セットアップ手順

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 開発サーバーの起動

```bash
npm run dev
```

ブラウザで http://localhost:4321 を開いてください。

### 3. 本番ビルド

```bash
npm run build
```

`dist/` ディレクトリに静的ファイルが生成されます。

### 4. ビルド結果のプレビュー

```bash
npm run preview
```

## ディレクトリ構成

```
/
├── src/
│   ├── pages/
│   │   ├── index.astro          # トップページ（最新記事一覧）
│   │   └── blog/
│   │       ├── index.astro      # ブログ一覧ページ
│   │       └── [slug].astro     # 記事詳細ページ
│   ├── layouts/
│   │   └── BaseLayout.astro     # 共通レイアウト（HTML構造・フォント読込）
│   ├── components/
│   │   ├── Header.astro         # ヘッダー・ナビゲーション
│   │   ├── Footer.astro         # フッター
│   │   └── BlogCard.astro       # 記事カードコンポーネント
│   └── content/
│       ├── config.ts            # コンテンツコレクションのスキーマ定義
│       └── blog/
│           └── example.md       # サンプル記事
├── public/
│   └── images/                  # 画像ファイル置き場
├── astro.config.mjs
├── tailwind.config.mjs
└── package.json
```

## ブログ記事の追加方法

`src/content/blog/` に Markdown ファイルを追加します。ファイル名がURLのスラッグになります。

```markdown
---
title: "記事タイトル"
date: 2025-08-20
category: "カテゴリ名"
coverImage: "/images/cover.jpg"
excerpt: "記事の要約（一覧ページに表示されます）"
---

本文をここに書く。

## 見出し

本文テキスト。
```

### フロントマター フィールド

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `title` | string | ✅ | 記事タイトル |
| `date` | date | ✅ | 公開日（YYYY-MM-DD形式） |
| `category` | string | ✅ | カテゴリ名 |
| `coverImage` | string | ✅ | カバー画像パス（`/images/`以下） |
| `excerpt` | string | ✅ | 記事の要約文 |

### カバー画像の追加

`public/images/` ディレクトリに画像ファイルを配置し、フロントマターで `/images/ファイル名.jpg` と指定してください。

## カスタマイズ

### サイト名の変更

以下のファイルでサイト名を変更できます。
- `src/components/Header.astro` — ヘッダーのロゴテキスト
- `src/pages/index.astro` — ヒーローセクションのタイトル

### フォントの変更

`tailwind.config.mjs` の `fontFamily.sans` と `src/layouts/BaseLayout.astro` の Google Fonts の読み込みURLを変更してください。
