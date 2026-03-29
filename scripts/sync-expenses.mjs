import { google } from 'googleapis';

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID?.trim();
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();

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

// ── 1. Sheetsの既存データ（DriveリンクのD列）を取得して重複チェック用に準備 ──
const existingRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: 'D:D',
});
const existingLinks = new Set(
  (existingRes.data.values || []).flat().filter(Boolean)
);
console.log(`既存レコード数: ${existingLinks.size}`);

// ── 2. Driveフォルダの全ファイルを取得 ────────────────────────────────────
const filesRes = await drive.files.list({
  q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
  orderBy: 'createdTime asc',
  pageSize: 100,
  fields: 'files(id, name, webViewLink, mimeType, createdTime)',
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
});

const files = filesRes.data.files || [];
console.log(`Driveファイル数: ${files.length}`);

const accessToken = await authClient.getAccessToken();
let addedCount = 0;

for (const file of files) {
  // 重複スキップ
  if (existingLinks.has(file.webViewLink)) {
    console.log(`スキップ（既存）: ${file.name}`);
    continue;
  }

  console.log(`処理中: ${file.name}`);

  // ── 3. ファイルをダウンロードしてOCR ──────────────────────────────────
  let ocrText = '';
  try {
    const fileRes = await drive.files.get(
      { fileId: file.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const fileBase64 = Buffer.from(fileRes.data).toString('base64');
    const isPdf = file.mimeType === 'application/pdf';

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

    ocrText = isPdf
      ? visionData.responses?.[0]?.responses?.[0]?.fullTextAnnotation?.text || ''
      : visionData.responses?.[0]?.fullTextAnnotation?.text || '';
  } catch (e) {
    console.warn(`OCRエラー（${file.name}）:`, e.message);
  }

  // ── 4. 金額を抽出 ───────────────────────────────────────────────────
  const amountMatch = ocrText.match(/[¥￥][\d,]+|[\d,]+円/);
  const rawAmount = amountMatch ? amountMatch[0].replace(/[¥￥円,]/g, '') : '';
  const displayAmount = rawAmount ? `¥${parseInt(rawAmount).toLocaleString()}` : '不明';

  // ── 5. 日付をファイルの作成日から取得 ─────────────────────────────────
  const date = file.createdTime
    ? file.createdTime.split('T')[0]
    : new Date().toISOString().split('T')[0];

  // ── 6. Sheetsに追記 ────────────────────────────────────────────────
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A2:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        date,
        file.name,
        displayAmount,
        file.webViewLink,
      ]],
    },
  });

  existingLinks.add(file.webViewLink);
  addedCount++;
  console.log(`追加: ${file.name} → ${displayAmount}`);
}

console.log(`\n完了: ${addedCount}件追加しました`);
