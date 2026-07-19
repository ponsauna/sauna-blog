import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// .envを読み込む
const envPath = resolve(fileURLToPath(import.meta.url), '../.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf-8')
    .split('\n')
    .filter(line => line.includes('='))
    .map(line => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const payload = {
  saunaUrl: 'https://sauna-ikitai.com/saunas/2', // 渋谷SAUNAS
  notes: '初訪問。オートロウリュが最高だった。水風呂も深くて最高。',
  visitDate: '2026-03-29',
};

console.log('🚀 Webhook テスト開始...');
console.log('サウナイキタイURL:', payload.saunaUrl);
console.log('訪問日:', payload.visitDate);
console.log('');

try {
  const res = await fetch('http://localhost:3000/api/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': env.WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (res.ok) {
    console.log('✅ 成功！');
    console.log('📁 レシートファイル:', data.receiptFile);
    console.log('🔗 Drive:', data.driveLink);
    console.log('📝 PR:', data.prUrl);
    console.log('💰 金額:', data.amount);
  } else {
    console.log('❌ エラー:', data.error);
  }
} catch (e) {
  console.error('接続エラー（vercel devは起動していますか？）:', e.message);
}
