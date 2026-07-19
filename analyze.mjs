import { google } from 'googleapis';
import { readFileSync } from 'fs';

const KEY = JSON.parse(readFileSync('./service-account.json', 'utf8'));
const SITE = 'https://www.tsuyoshishirota.com/';

const auth = new google.auth.GoogleAuth({
  credentials: KEY,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

const sc = google.searchconsole({ version: 'v1', auth });

const today = new Date();
const fmt = (d) => d.toISOString().split('T')[0];
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

async function query(startDate, endDate, dimensions) {
  const res = await sc.searchanalytics.query({
    siteUrl: SITE,
    requestBody: { startDate, endDate, dimensions, rowLimit: 10 },
  });
  return res.data.rows || [];
}

async function main() {
  console.log('=== Search Console 分析 ===\n');

  // 今日 vs 昨日
  const todayStr = fmt(today);
  const yesterdayStr = fmt(daysAgo(1));
  const weekAgoStr = fmt(daysAgo(7));

  // 直近7日間のページ別
  console.log('📄 直近7日間 ページ別クリック数 TOP10');
  const pages = await query(weekAgoStr, todayStr, ['page']);
  pages
    .sort((a, b) => b.clicks - a.clicks)
    .forEach((r, i) => {
      const page = r.keys[0].replace(SITE, '/');
      console.log(`  ${i + 1}. ${page}`);
      console.log(`     クリック: ${r.clicks} | 表示: ${r.impressions} | CTR: ${(r.ctr * 100).toFixed(1)}% | 順位: ${r.position.toFixed(1)}`);
    });

  console.log('\n🔍 直近7日間 キーワード別クリック数 TOP10');
  const keywords = await query(weekAgoStr, todayStr, ['query']);
  keywords
    .sort((a, b) => b.clicks - a.clicks)
    .forEach((r, i) => {
      console.log(`  ${i + 1}. "${r.keys[0]}"`);
      console.log(`     クリック: ${r.clicks} | 表示: ${r.impressions} | CTR: ${(r.ctr * 100).toFixed(1)}% | 順位: ${r.position.toFixed(1)}`);
    });

  // 今日のデータ
  console.log('\n📊 今日のサマリー');
  const todayData = await query(todayStr, todayStr, ['page']);
  const totalClicks = todayData.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = todayData.reduce((s, r) => s + r.impressions, 0);
  console.log(`  クリック合計: ${totalClicks}`);
  console.log(`  表示回数合計: ${totalImpressions}`);

  if (todayData.length > 0) {
    console.log('\n  今日 クリックされたページ:');
    todayData.sort((a, b) => b.clicks - a.clicks).forEach((r) => {
      if (r.clicks > 0) {
        const page = r.keys[0].replace(SITE, '/');
        console.log(`    ${page} → ${r.clicks}クリック`);
      }
    });
  }
}

main().catch(console.error);
