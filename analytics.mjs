import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { readFileSync } from 'fs';

const KEY = JSON.parse(readFileSync('./service-account.json', 'utf8'));
const PROPERTY_ID = '529364809';

const client = new BetaAnalyticsDataClient({
  credentials: {
    client_email: KEY.client_email,
    private_key: KEY.private_key,
  },
});

async function main() {
  console.log('=== Google Analytics 分析 ===\n');

  // リアルタイム（今アクセスしている人）
  try {
    const [realtime] = await client.runRealtimeReport({
      property: `properties/${PROPERTY_ID}`,
      metrics: [{ name: 'activeUsers' }],
    });

    const totalUsers = realtime.rows?.reduce((s, r) => s + parseInt(r.metricValues[0].value), 0) || 0;
    console.log(`👥 リアルタイム アクティブユーザー: ${totalUsers}人`);
    if (realtime.rows?.length > 0) {
      console.log('  閲覧中のページ:');
      realtime.rows.forEach(r => {
        const page = r.dimensionValues?.[0]?.value ?? '(不明)';
        console.log(`    ${page} → ${r.metricValues[0].value}人`);
      });
    }
  } catch (e) {
    console.log('リアルタイム:', e.message);
  }

  // 今日のページ別セッション
  try {
    const [today] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: 'today', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    });

    console.log('\n📄 今日のページ別セッション TOP10');
    if (today.rows?.length > 0) {
      today.rows.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.dimensionValues[0].value}`);
        console.log(`     セッション: ${r.metricValues[0].value} | PV: ${r.metricValues[1].value}`);
      });
    } else {
      console.log('  まだデータがありません（トラッキングコード反映待ち）');
    }
  } catch (e) {
    console.log('今日のデータ:', e.message);
  }

  // 直近7日間の流入元
  try {
    const [sources] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    });

    console.log('\n🔀 直近7日間 流入元');
    if (sources.rows?.length > 0) {
      sources.rows.forEach(r => {
        console.log(`  ${r.dimensionValues[0].value}: ${r.metricValues[0].value}セッション`);
      });
    } else {
      console.log('  まだデータがありません');
    }
  } catch (e) {
    console.log('流入元:', e.message);
  }
}

main().catch(console.error);
