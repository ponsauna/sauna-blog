export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(200).json({ ok: true });
}
