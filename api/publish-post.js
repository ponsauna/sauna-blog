export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.WEBHOOK_SECRET?.trim()) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { draft, saunaName, visitDate, photos = [], thumbnail } = req.body;
    if (!draft || !saunaName) return res.status(400).json({ error: 'draft と saunaName が必要です' });

    const date = visitDate || new Date().toISOString().split('T')[0];
    const slug = saunaName.trim().replace(/\s+/g, '-').replace(/[^\w　-鿿゠-ヿ぀-ゟ-]/g, '');
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
    const GITHUB_REPO = process.env.GITHUB_REPO?.trim();

    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    const api = `https://api.github.com/repos/${GITHUB_REPO}`;

    // coverImage を実際のパスに置換
    const coverPath = `/images/posts/${slug}/cover.jpg`;
    const finalDraft = draft.replace(/coverImage:.*/, `coverImage: "${coverPath}"`);

    // ── ファイルを順番にコミット ──
    const mdFile = `src/content/blog/${date}-${slug}.md`;
    await commitFile(api, headers, mdFile, Buffer.from(finalDraft).toString('base64'),
      `blog: ${saunaName}の記事を追加`);

    // 写真 01.jpg, 02.jpg ...
    for (let i = 0; i < Math.min(photos.length, 5); i++) {
      const num = String(i + 1).padStart(2, '0');
      await commitFile(api, headers,
        `public/images/posts/${slug}/${num}.jpg`, photos[i],
        `images: ${saunaName}の写真を追加`);
    }

    // サムネ cover.jpg
    if (thumbnail) {
      await commitFile(api, headers,
        `public/images/posts/${slug}/cover.jpg`, thumbnail,
        `images: ${saunaName}のサムネを追加`);
    }

    const blogUrl = `https://tsuyoshishirota.com/blog/${date}-${slug}/`;
    return res.status(200).json({ success: true, blogUrl });
  } catch (err) {
    console.error('publish-post:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function commitFile(api, headers, path, base64Content, message) {
  // 既存ファイルのSHAを取得（更新の場合に必要）
  let sha;
  try {
    const r = await fetch(`${api}/contents/${path}`, { headers });
    if (r.ok) { const d = await r.json(); sha = d.sha; }
  } catch (_) {}

  const body = { message, content: base64Content, branch: 'main' };
  if (sha) body.sha = sha;

  const r = await fetch(`${api}/contents/${path}`, {
    method: 'PUT', headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(`GitHub commit failed (${path}): ${JSON.stringify(err)}`);
  }
}
