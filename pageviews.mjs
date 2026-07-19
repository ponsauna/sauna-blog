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

const [response] = await client.runReport({
  property: `properties/${PROPERTY_ID}`,
  dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
  dimensions: [{ name: 'date' }],
  metrics: [{ name: 'screenPageViews' }],
  orderBys: [{ dimension: { dimensionName: 'date' } }],
});

console.log('日付         PV');
console.log('──────────────────');
let total = 0;
for (const row of response.rows) {
  const d = row.dimensionValues[0].value;
  const pv = parseInt(row.metricValues[0].value);
  total += pv;
  console.log(`${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6)}   ${pv.toLocaleString()}`);
}
console.log('──────────────────');
console.log(`合計         ${total.toLocaleString()}`);
