import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

const SITE_URL = 'https://tsuyoshishirota.com/';

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function queryGSC(sc, startDate, endDate, dimensions, pageFilter) {
  const body = { startDate, endDate, dimensions, rowLimit: 500 };
  if (pageFilter) {
    body.dimensionFilterGroups = [{
      filters: [{ dimension: 'page', operator: 'equals', expression: pageFilter }],
    }];
  }
  const r = await sc.searchanalytics.query({ siteUrl: SITE_URL, requestBody: body });
  return r.data.rows || [];
}

async function postSlack(webhookUrl, blocks, text) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    });
  } catch (e) {
    console.error('Slack通知エラー:', e.message);
  }
}

export default async function handler(req, res) {
  const secret = req.headers['x-api-secret']
    || req.headers['authorization']?.replace('Bearer ', '');
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL?.trim();

  try {
    // ── Google Search Console 認証 ─────────────────────────────────
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    const sc = google.searchconsole({ version: 'v1', auth });

    // GSCは3日前までしかデータがない
    const currEnd   = dateStr(3);
    const currStart = dateStr(31);
    const prevEnd   = dateStr(31);
    const prevStart = dateStr(59);

    const [currRows, prevRows] = await Promise.all([
      queryGSC(sc, currStart, currEnd, ['page']),
      queryGSC(sc, prevStart, prevEnd, ['page']),
    ]);

    const curr = Object.fromEntries(currRows.map(r => [r.keys[0], r]));
    const prev = Object.fromEntries(prevRows.map(r => [r.keys[0], r]));

    const blogPages = [...new Set([
      ...currRows.map(r => r.keys[0]),
      ...prevRows.map(r => r.keys[0]),
    ])].filter(u => u.includes('/blog/') && !u.endsWith('/blog/'));

    const pageStats = blogPages.map(url => {
      const c = curr[url] || { clicks: 0, impressions: 0, ctr: 0, position: 100 };
      const p = prev[url] || { clicks: 0, impressions: 0, ctr: 0, position: 100 };
      return {
        url,
        curr:  { clicks: c.clicks, impressions: c.impressions, ctr: c.ctr, position: c.position },
        prev:  { clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position },
        clickChange: p.clicks > 0 ? (c.clicks - p.clicks) / p.clicks : 0,
        posChange:   p.position < 99 ? c.position - p.position : 0,
      };
    }).sort((a, b) => b.curr.impressions - a.curr.impressions);

    const totalClicks      = currRows.reduce((s, r) => s + r.clicks, 0);
    const totalImpressions = currRows.reduce((s, r) => s + r.impressions, 0);
    const avgCtr = currRows.length
      ? (currRows.reduce((s, r) => s + r.ctr, 0) / currRows.length * 100).toFixed(1)
      : '0.0';

    // GET = レポートのみ
    if (req.method === 'GET') {
      return res.status(200).json({
        period: { curr: [currStart, currEnd], prev: [prevStart, prevEnd] },
        summary: { totalClicks, totalImpressions, avgCtr },
        pageStats,
      });
    }

    // ── POST = 最適化実行 ──────────────────────────────────────────
    const toFix = pageStats.filter(p =>
      (p.curr.impressions >= 30 && p.curr.ctr < 0.03) ||
      (p.clickChange < -0.3 && p.prev.clicks >= 5)
    ).slice(0, 5);

    const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
    const GITHUB_REPO  = process.env.GITHUB_REPO?.trim();
    const ghHeaders = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    const repoApi = `https://api.github.com/repos/${GITHUB_REPO}`;

    const filesRes = await fetch(`${repoApi}/contents/src/content/blog`, { headers: ghHeaders });
    const files = await filesRes.json();

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() });
    const fixed = [];
    const skipped = [];

    for (const page of toFix) {
      const slug = page.url.replace(SITE_URL + 'blog/', '').replace(/\/$/, '');

      const file = files.find(f => {
        const name = f.name.replace('.md', '');
        return name === slug || name.includes(slug) || slug.includes(name);
      });
      if (!file) { skipped.push({ url: page.url, reason: 'file_not_found' }); continue; }

      const fileRes  = await fetch(file.url, { headers: ghHeaders });
      const fileData = await fileRes.json();
      const content  = Buffer.from(fileData.content, 'base64').toString('utf-8');

      const oldTitle   = (content.match(/^title:\s*"?(.+?)"?\s*$/m) || [])[1] || '';
      const oldExcerpt = (content.match(/^excerpt:\s*"?(.+?)"?\s*$/m) || [])[1] || '';

      const queryRows = await queryGSC(sc, currStart, currEnd, ['query'], page.url);
      const topQueries = queryRows.slice(0, 10)
        .map(r => `"${r.keys[0]}": ${r.clicks}クリック, ${r.impressions}表示, 順位${r.position.toFixed(1)}`);

      const problems = [];
      if (page.curr.ctr < 0.03 && page.curr.impressions >= 30)
        problems.push(`CTRが${(page.curr.ctr * 100).toFixed(1)}%（基準3%を下回る）`);
      if (page.clickChange < -0.3 && page.prev.clicks >= 5)
        problems.push(`クリック数が前期比${(page.clickChange * 100).toFixed(0)}%減`);
      if (page.posChange > 3)
        problems.push(`平均順位が${page.posChange.toFixed(1)}位低下（現在${page.curr.position.toFixed(1)}位）`);

      const claudeRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: `あなたはプロのSEOマネージャーです。以下のデータを分析し、改善案を作成してください。

【記事情報】
URL: ${page.url}
現在のtitle: ${oldTitle}
現在のexcerpt: ${oldExcerpt}

【パフォーマンス（直近28日）】
クリック数: ${page.curr.clicks}（前期比${page.clickChange >= 0 ? '+' : ''}${(page.clickChange * 100).toFixed(0)}%）
表示回数: ${page.curr.impressions}
CTR: ${(page.curr.ctr * 100).toFixed(1)}%
平均順位: ${page.curr.position.toFixed(1)}位

【問題点】
${problems.join('\n')}

【上位検索クエリ】
${topQueries.length ? topQueries.join('\n') : 'データなし'}

以下のJSON形式のみで返してください：
{
  "title": "新しいtitle（60文字以内、主要キーワードを前半に配置）",
  "excerpt": "新しいexcerpt（120文字以内、クエリキーワードを自然に含む）",
  "analysis": "なぜこの変更をするのか、どのキーワードを狙うのか、何が改善されると予測するか（3〜5文で具体的に）"
}`,
        }],
      });

      const responseText = claudeRes.content[0]?.text?.trim() || '{}';
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      let optimized = {};
      try { optimized = jsonMatch ? JSON.parse(jsonMatch[0]) : {}; } catch (_) {}

      if (!optimized.title || !optimized.excerpt) {
        skipped.push({ url: page.url, reason: 'claude_parse_failed' });
        continue;
      }

      const updatedContent = content
        .replace(/^title:.*$/m, `title: "${optimized.title.replace(/"/g, '\\"')}"`)
        .replace(/^excerpt:.*$/m, `excerpt: "${optimized.excerpt.replace(/"/g, '\\"')}"`);

      const commitRes = await fetch(file.url, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `seo: ${slug}のtitle・excerptを最適化`,
          content: Buffer.from(updatedContent).toString('base64'),
          sha: fileData.sha,
          branch: 'main',
        }),
      });
      if (!commitRes.ok) {
        skipped.push({ url: page.url, reason: 'commit_failed' });
        continue;
      }

      fixed.push({
        url: page.url,
        slug,
        oldTitle,
        newTitle: optimized.title,
        oldExcerpt,
        newExcerpt: optimized.excerpt,
        analysis: optimized.analysis || '',
        problems,
        metrics: {
          clicks: page.curr.clicks,
          impressions: page.curr.impressions,
          ctr: (page.curr.ctr * 100).toFixed(1),
          position: page.curr.position.toFixed(1),
          clickChange: (page.clickChange * 100).toFixed(0),
        },
      });
    }

    // ── Slack 通知 ────────────────────────────────────────────────
    const prevClicks = prevRows.reduce((s, r) => s + r.clicks, 0);
    const clickDelta = prevClicks > 0
      ? ((totalClicks - prevClicks) / prevClicks * 100).toFixed(0)
      : '–';
    const arrow = Number(clickDelta) >= 0 ? '↑' : '↓';
    const ranAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const slackBlocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📊 週次SEOレポート', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*分析日時：* ${ranAt}\n*分析記事数：* ${pageStats.length}記事`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*📈 直近28日間のパフォーマンス*',
            `• クリック数：*${totalClicks}回* ${arrow}${Math.abs(Number(clickDelta))}%（前期比）`,
            `• 表示回数：*${totalImpressions}回*`,
            `• 平均CTR：*${avgCtr}%*`,
          ].join('\n'),
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: fixed.length > 0
            ? `*🔧 今週の改善：${fixed.length}記事を最適化しました*`
            : toFix.length === 0
              ? '*✅ 問題のある記事は見つかりませんでした*'
              : `*対象${toFix.length}記事のうち${skipped.length}記事をスキップしました*`,
        },
      },
    ];

    // 修正記事ごとの詳細ブロック
    for (const f of fixed) {
      slackBlocks.push({ type: 'divider' });
      slackBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*📝 <${f.url}|${f.slug}>*`,
            '',
            `*⚠️ 問題点*`,
            f.problems.map(p => `• ${p}`).join('\n'),
            '',
            `*📊 メトリクス*`,
            `クリック: ${f.metrics.clicks}（${f.metrics.clickChange}%） | 表示: ${f.metrics.impressions} | CTR: ${f.metrics.ctr}% | 順位: ${f.metrics.position}位`,
            '',
            `*旧タイトル*`,
            `_${f.oldTitle}_`,
            '',
            `*✅ 新タイトル*`,
            `*${f.newTitle}*`,
            '',
            `*🧠 変更理由・戦略*`,
            f.analysis,
          ].join('\n'),
        },
      });
    }

    if (skipped.length > 0) {
      slackBlocks.push({ type: 'divider' });
      slackBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*⏭️ スキップした記事*\n${skipped.map(s => `• ${s.url}（${s.reason}）`).join('\n')}`,
        },
      });
    }

    slackBlocks.push({ type: 'divider' });
    slackBlocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '🤖 tsuyoshishirota.com SEO自動化 powered by Claude Haiku + Google Search Console' }],
    });

    const slackText = fixed.length > 0
      ? `社長、今週のSEOレポートです。${fixed.length}記事を改善しました 🔧`
      : '社長、今週のSEOレポートです。';

    await postSlack(SLACK_WEBHOOK, slackBlocks, slackText);

    return res.status(200).json({
      success: true,
      ranAt: new Date().toISOString(),
      summary: { totalClicks, totalImpressions, avgCtr },
      analyzed: pageStats.length,
      targeted: toFix.length,
      fixed,
      skipped,
    });

  } catch (err) {
    console.error('seo-weekly error:', err.message, err.stack);

    await postSlack(SLACK_WEBHOOK, [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*❌ SEO自動化でエラーが発生しました*\n\`${err.message}\`` },
    }], '社長、エラーが発生しました。確認をお願いします。');

    return res.status(500).json({
      error: err.message,
      details: err.response?.data || err.cause?.message || null,
    });
  }
}
