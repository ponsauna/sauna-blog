import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import { Readable } from 'stream';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });

    // ── 1. Claude Vision で OCR ──────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() });

    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: image },
          },
          {
            type: 'text',
            text: `このレシートから以下の情報をJSON形式で抽出してください。
- saunaName: 店舗・施設名（例：「渋谷SAUNAS」「サウナラボ神田」）
- date: 利用日（YYYY-MM-DD形式。不明なら空文字）
- amount: 支払金額（数字のみ。不明なら空文字）

JSONのみ返してください。例：{"saunaName":"渋谷SAUNAS","date":"2026-07-19","amount":"3200"}`,
          },
        ],
      }],
    });

    const text = result.content[0]?.text?.trim() || '{}';
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    let data = {};
    try { data = jsonMatch ? JSON.parse(jsonMatch[0]) : {}; } catch (_) {}

    const saunaName = data.saunaName || '';
    const date = data.date || new Date().toISOString().split('T')[0];
    const amount = data.amount || '';

    // ── 2. Google Drive にアップロード ───────────────────────────────
    let driveUrl = '';
    try {
      const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      const authClient = await auth.getClient();
      const drive = google.drive({ version: 'v3', auth: authClient });

      const fileName = `${date}_${saunaName || 'レシート'}.jpg`;
      const fileRes = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [FOLDER_ID],
          mimeType: 'image/jpeg',
        },
        media: {
          mimeType: 'image/jpeg',
          body: Readable.from(Buffer.from(image, 'base64')),
        },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });

      driveUrl = fileRes.data.webViewLink || '';
    } catch (driveErr) {
      console.error('Drive upload error (non-fatal):', driveErr.message);
    }

    return res.status(200).json({ saunaName, date, amount, driveUrl });
  } catch (err) {
    console.error('ocr-receipt error:', err);
    return res.status(500).json({ error: err.message });
  }
}
