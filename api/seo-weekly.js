import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { google } from 'googleapis';
import {
  createSeoProposal,
  postSlackBotMessage,
  slackAutomationConfigured,
} from '../lib/seo-automation.js';

const DEFAULT_SITE_URL = 'https://tsuyoshishirota.com/';
const DEFAULT_GA4_PROPERTY_ID = '529364809';
const DATA_DELAY_DAYS = 3;

function dateInPacific(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodEnding(daysAgo, length) {
  const end = dateInPacific(daysAgo);
  return { start: shiftDate(end, -(length - 1)), end };
}

async function queryGSC(sc, siteUrl, startDate, endDate, dimensions = []) {
  const requestBody = { startDate, endDate, rowLimit: 25000 };
  if (dimensions.length > 0) requestBody.dimensions = dimensions;
  const response = await sc.searchanalytics.query({ siteUrl, requestBody });
  return response.data.rows || [];
}

function metricFromSummaryRows(rows) {
  const row = rows[0] || {};
  return {
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: (row.ctr || 0) * 100,
    position: row.position || 0,
  };
}

function normalizePageUrl(rawUrl, canonicalOrigin) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== canonicalOrigin) return null;
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

function aggregateRows(rows, keyTransform = (key) => key) {
  const map = new Map();
  for (const row of rows) {
    const key = keyTransform(row.keys?.[0] || '');
    if (!key) continue;
    const existing = map.get(key) || {
      key,
      clicks: 0,
      impressions: 0,
      positionWeight: 0,
    };
    existing.clicks += row.clicks || 0;
    existing.impressions += row.impressions || 0;
    existing.positionWeight += (row.position || 0) * (row.impressions || 0);
    map.set(key, existing);
  }
  return [...map.values()].map((item) => ({
    key: item.key,
    clicks: item.clicks,
    impressions: item.impressions,
    ctr: item.impressions ? item.clicks / item.impressions : 0,
    position: item.impressions ? item.positionWeight / item.impressions : 0,
  }));
}

function pageComparison(currentRows, previousRows, canonicalOrigin) {
  const normalize = (url) => normalizePageUrl(url, canonicalOrigin);
  const current = new Map(aggregateRows(currentRows, normalize).map((row) => [row.key, row]));
  const previous = new Map(aggregateRows(previousRows, normalize).map((row) => [row.key, row]));
  const urls = new Set([...current.keys(), ...previous.keys()]);

  return [...urls]
    .filter((url) => new URL(url).pathname.startsWith('/blog/'))
    .map((url) => {
      const curr = current.get(url) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      const prev = previous.get(url) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      return {
        url,
        curr,
        prev,
        clickDelta: curr.clicks - prev.clicks,
        impressionDelta: curr.impressions - prev.impressions,
        ctrDelta: (curr.ctr - prev.ctr) * 100,
        positionDelta: curr.position && prev.position ? curr.position - prev.position : null,
      };
    })
    .sort((a, b) => b.curr.impressions - a.curr.impressions);
}

function queryComparison(currentRows, previousRows) {
  const current = new Map(aggregateRows(currentRows).map((row) => [row.key, row]));
  const previous = new Map(aggregateRows(previousRows).map((row) => [row.key, row]));
  const queries = new Set([...current.keys(), ...previous.keys()]);
  return [...queries]
    .map((query) => {
      const curr = current.get(query) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      const prev = previous.get(query) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      return { query, curr, prev, clickDelta: curr.clicks - prev.clicks };
    })
    .sort((a, b) => b.curr.impressions - a.curr.impressions);
}

function queriesByPage(rows, canonicalOrigin) {
  const pages = new Map();
  for (const row of rows) {
    const page = normalizePageUrl(row.keys?.[0] || '', canonicalOrigin);
    const query = row.keys?.[1]?.trim();
    if (!page || !query) continue;
    const entries = pages.get(page) || [];
    entries.push({
      query,
      impressions: row.impressions || 0,
      clicks: row.clicks || 0,
    });
    pages.set(page, entries);
  }
  for (const entries of pages.values()) {
    entries.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  }
  return pages;
}

async function queryOrganicGA4(credentials, propertyId, period) {
  if (!propertyId) return null;
  const client = new BetaAnalyticsDataClient({ credentials });
  const [report] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: period.start, endDate: period.end }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
      { name: 'keyEvents' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
      },
    },
  });
  const values = report.rows?.[0]?.metricValues?.map((metric) => Number(metric.value)) || [];
  return {
    sessions: values[0] || 0,
    users: values[1] || 0,
    pageViews: values[2] || 0,
    engagedSessions: values[3] || 0,
    engagementRate: (values[4] || 0) * 100,
    averageSessionDuration: values[5] || 0,
    keyEvents: values[6] || 0,
  };
}

function percentChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function formatDelta(current, previous, suffix = '') {
  const delta = percentChange(current, previous);
  if (delta === null) return `${current.toLocaleString('ja-JP')}${suffix}（比較不可）`;
  const sign = delta > 0 ? '+' : '';
  return `${current.toLocaleString('ja-JP')}${suffix}（${sign}${delta.toFixed(1)}%）`;
}

function pageLabel(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/blog\//, '')) || url;
  } catch {
    return url;
  }
}

async function postSlack(webhookUrl, blocks, text) {
  if (process.env.SLACK_BOT_TOKEN?.trim() && process.env.SLACK_CHANNEL_ID?.trim()) {
    try {
      await postSlackBotMessage({ blocks, text });
      return;
    } catch (error) {
      console.error('Slack Bot通知エラー:', error.message);
    }
  }
  if (!webhookUrl) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
      });
      if (response.ok) return;
      console.error(`Slack通知失敗（試行${attempt}, status=${response.status}）:`, await response.text());
    } catch (error) {
      console.error(`Slack通知エラー（試行${attempt}）:`, error.message);
    }
  }
}

export default async function handler(req, res) {
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authorization = req.headers.authorization || '';
  const isCronRequest = Boolean(cronSecret && authorization === `Bearer ${cronSecret}`);
  const isManualRequest = Boolean(webhookSecret && req.headers['x-api-secret'] === webhookSecret);

  if (!isCronRequest && !isManualRequest) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed. This endpoint is report-only.' });
  }

  const slackWebhook = process.env.SLACK_WEBHOOK_URL?.trim();
  const siteUrl = process.env.GSC_SITE_URL?.trim() || DEFAULT_SITE_URL;
  const canonicalOrigin = new URL(DEFAULT_SITE_URL).origin;
  const ga4PropertyId = process.env.GA4_PROPERTY_ID?.trim() || DEFAULT_GA4_PROPERTY_ID;

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    const sc = google.searchconsole({ version: 'v1', auth });

    const current7 = periodEnding(DATA_DELAY_DAYS, 7);
    const previous7 = {
      start: shiftDate(current7.start, -7),
      end: shiftDate(current7.end, -7),
    };
    const current28 = periodEnding(DATA_DELAY_DAYS, 28);
    const previous28 = {
      start: shiftDate(current28.start, -28),
      end: shiftDate(current28.end, -28),
    };

    const [
      current7SummaryRows,
      previous7SummaryRows,
      current28SummaryRows,
      previous28SummaryRows,
      currentPageRows,
      previousPageRows,
      currentQueryRows,
      previousQueryRows,
      currentPageQueryRows,
      currentGAResult,
      previousGAResult,
    ] = await Promise.all([
      queryGSC(sc, siteUrl, current7.start, current7.end),
      queryGSC(sc, siteUrl, previous7.start, previous7.end),
      queryGSC(sc, siteUrl, current28.start, current28.end),
      queryGSC(sc, siteUrl, previous28.start, previous28.end),
      queryGSC(sc, siteUrl, current28.start, current28.end, ['page']),
      queryGSC(sc, siteUrl, previous28.start, previous28.end, ['page']),
      queryGSC(sc, siteUrl, current28.start, current28.end, ['query']),
      queryGSC(sc, siteUrl, previous28.start, previous28.end, ['query']),
      queryGSC(sc, siteUrl, current28.start, current28.end, ['page', 'query']),
      queryOrganicGA4(
        process.env.GA4_SERVICE_ACCOUNT_JSON
          ? JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON)
          : credentials,
        ga4PropertyId,
        current7,
      ).then((data) => ({ data, error: null })).catch((error) => ({ data: null, error: error.message })),
      queryOrganicGA4(
        process.env.GA4_SERVICE_ACCOUNT_JSON
          ? JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON)
          : credentials,
        ga4PropertyId,
        previous7,
      ).then((data) => ({ data, error: null })).catch((error) => ({ data: null, error: error.message })),
    ]);

    const currentGA = currentGAResult.data;
    const previousGA = previousGAResult.data;
    const summary = {
      current7: metricFromSummaryRows(current7SummaryRows),
      previous7: metricFromSummaryRows(previous7SummaryRows),
      current28: metricFromSummaryRows(current28SummaryRows),
      previous28: metricFromSummaryRows(previous28SummaryRows),
    };
    const pageStats = pageComparison(currentPageRows, previousPageRows, canonicalOrigin);
    const queryStats = queryComparison(currentQueryRows, previousQueryRows);
    const pageQueries = queriesByPage(currentPageQueryRows, canonicalOrigin);

    const winners = pageStats
      .filter((page) => page.curr.impressions >= 50 && page.clickDelta > 0)
      .sort((a, b) => b.clickDelta - a.clickDelta)
      .slice(0, 3);
    const decliners = pageStats
      .filter((page) =>
        page.curr.impressions + page.prev.impressions >= 100
        && (page.clickDelta < 0 || (page.positionDelta !== null && page.positionDelta >= 3))
      )
      .sort((a, b) => a.clickDelta - b.clickDelta)
      .slice(0, 3);
    const opportunities = pageStats
      .filter((page) =>
        page.curr.impressions >= 200
        && page.curr.position >= 4
        && page.curr.position <= 15
      )
      .slice(0, 3);
    const queryOpportunities = queryStats
      .filter((query) =>
        query.curr.impressions >= 50
        && query.curr.position >= 4
        && query.curr.position <= 15
      )
      .slice(0, 5);

    const report = {
      generatedAt: new Date().toISOString(),
      siteUrl,
      periods: { current7, previous7, current28, previous28 },
      summary: {
        ...summary,
        totalClicks: summary.current7.clicks,
        totalImpressions: summary.current7.impressions,
        avgCtr: Number(summary.current7.ctr.toFixed(1)),
      },
      ga4: {
        available: Boolean(currentGA && previousGA),
        current7: currentGA,
        previous7: previousGA,
        error: currentGAResult.error || previousGAResult.error || null,
      },
      pageStats,
      winners,
      decliners,
      opportunities,
      queryOpportunities,
      automaticChanges: 0,
    };

    if (!isCronRequest) {
      return res.status(200).json(report);
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📊 週次SEOレポート', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*対象期間：* ${current7.start}〜${current7.end}\n*比較期間：* ${previous7.start}〜${previous7.end}\nGoogle確定データの都合で直近3日を除外しています。`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*直近7日 vs 前7日（Search Console）*',
            `• クリック：*${formatDelta(summary.current7.clicks, summary.previous7.clicks)}*`,
            `• 表示回数：*${formatDelta(summary.current7.impressions, summary.previous7.impressions)}*`,
            `• CTR：*${summary.current7.ctr.toFixed(2)}%*（前期 ${summary.previous7.ctr.toFixed(2)}%）`,
            `• 平均順位：*${summary.current7.position.toFixed(1)}位*（前期 ${summary.previous7.position.toFixed(1)}位）`,
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*28日トレンド（Search Console）*',
            `• クリック：*${formatDelta(summary.current28.clicks, summary.previous28.clicks)}*`,
            `• 表示回数：*${formatDelta(summary.current28.impressions, summary.previous28.impressions)}*`,
            `• CTR：*${summary.current28.ctr.toFixed(2)}%*（前期 ${summary.previous28.ctr.toFixed(2)}%）`,
            `• 平均順位：*${summary.current28.position.toFixed(1)}位*（前期 ${summary.previous28.position.toFixed(1)}位）`,
          ].join('\n'),
        },
      },
    ];

    if (currentGA && previousGA) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*直近7日 vs 前7日（GA4・自然検索）*',
            `• セッション：*${formatDelta(currentGA.sessions, previousGA.sessions)}*`,
            `• ユーザー：*${formatDelta(currentGA.users, previousGA.users)}*`,
            `• エンゲージメント率：*${currentGA.engagementRate.toFixed(1)}%*（前期 ${previousGA.engagementRate.toFixed(1)}%）`,
            `• 平均滞在：*${currentGA.averageSessionDuration.toFixed(0)}秒*（前期 ${previousGA.averageSessionDuration.toFixed(0)}秒）`,
            `• キーイベント：*${currentGA.keyEvents}件*`,
          ].join('\n'),
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*GA4・自然検索：取得できません*\n`GA4_SERVICE_ACCOUNT_JSON`またはGA4閲覧権限を確認してください。',
        },
      });
    }

    const pageLines = (items) => items.map((page) =>
      `• <${page.url}|${pageLabel(page.url)}>：${page.curr.clicks}クリック / ${page.curr.impressions}表示 / CTR ${(page.curr.ctr * 100).toFixed(1)}% / ${page.curr.position.toFixed(1)}位`
    );

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*確認候補（自動変更はしません）*',
          ...(decliners.length ? ['*下落・要確認*', ...pageLines(decliners)] : ['• 下落判定に十分なデータなし']),
          ...(opportunities.length ? ['*4〜15位・200表示以上*', ...pageLines(opportunities)] : ['• 改善候補は母数不足のため判定保留']),
        ].join('\n'),
      },
    });

    if (winners.length) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ['*伸びた記事*', ...pageLines(winners)].join('\n'),
        },
      });
    }

    if (queryOpportunities.length) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*検索クエリ候補*',
            ...queryOpportunities.map((query) =>
              `• ${query.query}：${query.curr.impressions}表示 / CTR ${(query.curr.ctr * 100).toFixed(1)}% / ${query.curr.position.toFixed(1)}位`
            ),
          ].join('\n'),
        },
      });
    }

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: slackAutomationConfigured()
          ? '自動変更：0件。承認可能な提案がある場合は別メッセージで送ります。✅が付くまで本番は変更しません。'
          : '自動変更：0件。Slack App接続後は、別メッセージの✅で1記事1変更を承認できます。',
      }],
    });

    await postSlack(slackWebhook, blocks, '今週のSEOレポートです。未承認の変更は行いません。');

    report.proposal = { status: 'not_configured' };
    if (slackAutomationConfigured()) {
      const candidates = [...opportunities, ...decliners]
        .filter((candidate, index, items) => items.findIndex((item) => item.url === candidate.url) === index);
      for (const candidate of candidates) {
        try {
          const queries = (pageQueries.get(candidate.url) || []).slice(0, 5).map((item) => item.query);
          const result = await createSeoProposal({
            candidate,
            queries,
            canonicalOrigin,
            period: current28,
          });
          report.proposal = result;
          if (result.status === 'created') break;
        } catch (proposalError) {
          console.error('seo proposal error:', proposalError.message, proposalError.stack);
          report.proposal = { status: 'error', error: proposalError.message };
          await postSlack(slackWebhook, [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *SEO提案は作成されませんでした*\n${proposalError.message}\nサイトへの変更はありません。`,
            },
          }], 'SEO提案の作成に失敗しました。サイトへの変更はありません。');
          break;
        }
      }
      if (candidates.length === 0) report.proposal = { status: 'no_candidate' };
    }
    return res.status(200).json(report);
  } catch (error) {
    console.error('seo-weekly error:', error.message, error.stack);
    if (isCronRequest) {
      await postSlack(slackWebhook, [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*❌ SEOレポート取得エラー*\n\`${error.message}\`` },
      }], 'SEOレポートの取得に失敗しました。');
    }
    return res.status(500).json({
      error: error.message,
      details: error.response?.data || error.cause?.message || null,
    });
  }
}
