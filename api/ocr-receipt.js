import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });

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
    try {
      data = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch (_) {
      data = {};
    }

    return res.status(200).json({
      saunaName: data.saunaName || '',
      date: data.date || '',
      amount: data.amount || '',
    });
  } catch (err) {
    console.error('ocr-receipt error:', err);
    return res.status(500).json({ error: err.message });
  }
}
