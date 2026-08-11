import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const FORBIDDEN_TITLE_CLAIMS = /(最新|完全ガイド|徹底解説|絶対|必ず|No\.?1|ナンバーワン|日本一)/i;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function githubConfig() {
  return {
    token: requiredEnv('GITHUB_TOKEN'),
    repo: requiredEnv('GITHUB_REPO'),
  };
}

function encodeGithubPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function githubRequest(path, options = {}) {
  const { token, repo } = githubConfig();
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : data?.message || response.statusText;
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return data;
}

export async function getGithubFile(path, ref = 'main') {
  const data = await githubRequest(`/contents/${encodeGithubPath(path)}?ref=${encodeURIComponent(ref)}`);
  if (!data?.content || data.encoding !== 'base64') throw new Error(`GitHub file not found: ${path}`);
  return {
    content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    sha: data.sha,
  };
}

function frontmatterMatch(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Frontmatter not found');
  return match;
}

export function frontmatterValue(content, field) {
  const frontmatter = frontmatterMatch(content)[1];
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!match) throw new Error(`${field} is missing from frontmatter`);
  const raw = match[1].trim();
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw.replace(/^['"]|['"]$/g, '');
}

export function replaceFrontmatterValue(content, field, value) {
  const match = frontmatterMatch(content);
  const nextFrontmatter = match[1].replace(
    new RegExp(`^${field}:\\s*.*$`, 'm'),
    `${field}: ${JSON.stringify(value)}`,
  );
  if (nextFrontmatter === match[1]) throw new Error(`${field} could not be replaced`);
  return content.replace(match[0], `---\n${nextFrontmatter}\n---\n`);
}

function titleNumbers(value) {
  return value.match(/\d+(?:\.\d+)?/g) || [];
}

export function validateProposedTitle(oldTitle, newTitle, sourceContent) {
  const title = String(newTitle || '').trim();
  if (title === oldTitle) throw new Error('提案タイトルが現在と同じです');
  if (title.length < 10 || title.length > 70) throw new Error('提案タイトルは10〜70文字にしてください');
  if (/\r|\n|https?:\/\//i.test(title)) throw new Error('提案タイトルに改行またはURLは使用できません');
  if (FORBIDDEN_TITLE_CLAIMS.test(title)) throw new Error('誇張・鮮度を断定する表現は使用できません');
  if (/20\d{2}年/.test(title)) throw new Error('年号入りタイトルは使用できません');
  for (const number of titleNumbers(title)) {
    if (!sourceContent.includes(number)) throw new Error(`本文にない数値「${number}」は追加できません`);
  }
  return title;
}

export function validateOnlyTitleChanged(before, after) {
  const oldTitle = frontmatterValue(before, 'title');
  const newTitle = frontmatterValue(after, 'title');
  const beforeWithoutTitle = replaceFrontmatterValue(before, 'title', '__SEO_TITLE__');
  const afterWithoutTitle = replaceFrontmatterValue(after, 'title', '__SEO_TITLE__');
  if (beforeWithoutTitle !== afterWithoutTitle) {
    throw new Error('承認対象外の変更が含まれています');
  }
  validateProposedTitle(oldTitle, newTitle, before);
  return { oldTitle, newTitle };
}

export function articlePathFromUrl(pageUrl, canonicalOrigin) {
  const url = new URL(pageUrl);
  if (url.origin !== canonicalOrigin || !url.pathname.startsWith('/blog/')) {
    throw new Error('対象URLがブログ記事ではありません');
  }
  const slug = decodeURIComponent(url.pathname.replace(/^\/blog\//, '').replace(/\/+$/, ''));
  if (!slug || slug.includes('/') || slug.includes('..')) throw new Error('記事slugが不正です');
  return `src/content/blog/${slug}.md`;
}

export function slackAutomationConfigured() {
  return Boolean(
    process.env.SLACK_BOT_TOKEN?.trim()
    && process.env.SLACK_CHANNEL_ID?.trim()
    && process.env.SLACK_SIGNING_SECRET?.trim()
    && process.env.SLACK_APPROVER_USER_IDS?.trim()
    && process.env.GITHUB_TOKEN?.trim()
    && process.env.GITHUB_REPO?.trim()
    && process.env.ANTHROPIC_API_KEY?.trim()
  );
}

export async function slackApi(method, payload) {
  const token = requiredEnv('SLACK_BOT_TOKEN');
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Slack ${method}: ${data.error || response.statusText}`);
  return data;
}

export async function postSlackBotMessage({ blocks, text, threadTs }) {
  const channel = requiredEnv('SLACK_CHANNEL_ID');
  return slackApi('chat.postMessage', {
    channel,
    text,
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
}

export async function getSlackMessage(channel, timestamp) {
  const data = await slackApi('conversations.history', {
    channel,
    latest: timestamp,
    inclusive: true,
    include_all_metadata: true,
    limit: 1,
  });
  return data.messages?.find((message) => message.ts === timestamp) || null;
}

export function prNumberFromSlackMessage(message) {
  for (const block of message?.blocks || []) {
    const match = String(block.block_id || '').match(/^seo_pr_(\d+)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function verifySlackSignature(rawBody, headers, signingSecret, now = Date.now()) {
  const timestamp = headers.get('x-slack-request-timestamp');
  const signature = headers.get('x-slack-signature');
  if (!timestamp || !signature || !/^v0=[a-f0-9]{64}$/i.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function latestCommitDate(path) {
  const commits = await githubRequest(`/commits?sha=main&path=${encodeURIComponent(path)}&per_page=1`);
  const value = commits?.[0]?.commit?.committer?.date || commits?.[0]?.commit?.author?.date;
  return value ? new Date(value) : null;
}

async function hasOpenProposal(path) {
  const pulls = await githubRequest('/pulls?state=open&base=main&per_page=50');
  return pulls.some((pull) => pull.body?.includes(`<!-- seo-file:${path} -->`));
}

function proposalText(response) {
  return response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
}

function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI提案がJSON形式ではありません');
  return JSON.parse(match[0]);
}

async function generateTitleProposal({ content, queries, metrics }) {
  const oldTitle = frontmatterValue(content, 'title');
  const excerpt = frontmatterValue(content, 'excerpt');
  const prompt = `あなたは日本語SEO編集者です。次の記事について、タイトルだけを1回変更する提案を作ってください。

現在のタイトル: ${oldTitle}
現在の説明: ${excerpt}
直近28日の指標: 表示${metrics.impressions}、クリック${metrics.clicks}、CTR ${(metrics.ctr * 100).toFixed(1)}%、平均順位 ${metrics.position.toFixed(1)}
関連検索語句: ${queries.length ? queries.join(' / ') : '十分なデータなし'}

記事本文:
${content.slice(0, 9000)}

制約:
- 本文に書かれている事実だけを使う
- 年号、「最新」「完全」「徹底解説」「No.1」などの誇張表現を使わない
- 施設名と検索意図が自然に分かる日本語にする
- 10〜70文字
- 本文にない料金・時間・距離・順位などの数値を追加しない
- excerptや本文は変更しない
- JSONだけを返す

{"title":"提案タイトル","reason":"変更理由を80文字以内で"}`;

  const anthropic = new Anthropic({ apiKey: requiredEnv('ANTHROPIC_API_KEY') });
  const response = await anthropic.messages.create({
    model: process.env.SEO_PROPOSAL_MODEL?.trim() || DEFAULT_MODEL,
    max_tokens: 500,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = parseJsonObject(proposalText(response));
  return {
    oldTitle,
    newTitle: validateProposedTitle(oldTitle, parsed.title, content),
    reason: String(parsed.reason || '').trim().slice(0, 160),
  };
}

async function createPullRequest({ path, before, fileSha, proposal, candidate, queries, period }) {
  const mainRef = await githubRequest('/git/ref/heads/main');
  const mainSha = mainRef.object.sha;
  const branch = `seo-proposal/${period.end.replaceAll('-', '')}-${mainSha.slice(0, 7)}-${Date.now()}`;
  await githubRequest('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainSha }),
  });

  const after = replaceFrontmatterValue(before, 'title', proposal.newTitle);
  validateOnlyTitleChanged(before, after);
  await githubRequest(`/contents/${encodeGithubPath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `seo: propose title update for ${path.split('/').pop()}`,
      content: Buffer.from(after).toString('base64'),
      sha: fileSha,
      branch,
    }),
  });

  const body = [
    '<!-- seo-approval-flow:v1 -->',
    `<!-- seo-file:${path} -->`,
    '## Slack承認待ちSEO提案',
    '',
    `- 対象: ${candidate.url}`,
    `- 観測期間: ${period.start}〜${period.end}`,
    `- 表示回数: ${candidate.curr.impressions}`,
    `- クリック: ${candidate.curr.clicks}`,
    `- CTR: ${(candidate.curr.ctr * 100).toFixed(1)}%`,
    `- 平均順位: ${candidate.curr.position.toFixed(1)}位`,
    `- 関連語句: ${queries.length ? queries.join(' / ') : '十分なデータなし'}`,
    '',
    `**変更前:** ${proposal.oldTitle}`,
    '',
    `**変更後:** ${proposal.newTitle}`,
    '',
    `**理由:** ${proposal.reason}`,
    '',
    '変更対象はfrontmatterのtitle 1行だけです。Slackの承認リアクションが付くまでmainには反映しません。',
  ].join('\n');

  return githubRequest('/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: `[SEO提案] ${proposal.newTitle}`,
      body,
      head: branch,
      base: 'main',
      draft: false,
    }),
  });
}

export async function createSeoProposal({ candidate, queries, canonicalOrigin, period }) {
  if (!slackAutomationConfigured()) return { status: 'not_configured' };
  const path = articlePathFromUrl(candidate.url, canonicalOrigin);
  if (await hasOpenProposal(path)) return { status: 'open_proposal_exists', path };

  const lastChanged = await latestCommitDate(path);
  if (lastChanged && Date.now() - lastChanged.getTime() < 28 * 24 * 60 * 60 * 1000) {
    return { status: 'observation_window', path, lastChanged: lastChanged.toISOString() };
  }

  const file = await getGithubFile(path);
  if (/^noindex:\s*true\s*$/m.test(frontmatterMatch(file.content)[1])) {
    return { status: 'noindex', path };
  }

  const proposal = await generateTitleProposal({ content: file.content, queries, metrics: candidate.curr });
  const pull = await createPullRequest({
    path,
    before: file.content,
    fileSha: file.sha,
    proposal,
    candidate,
    queries,
    period,
  });

  try {
    await postSlackBotMessage({
      text: `SEO変更提案: ${proposal.oldTitle} → ${proposal.newTitle}`,
      blocks: [
        {
          type: 'header',
          block_id: `seo_pr_${pull.number}`,
          text: { type: 'plain_text', text: '💡 SEO変更提案（承認待ち）', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*対象:* <${candidate.url}|${decodeURIComponent(new URL(candidate.url).pathname.replace('/blog/', ''))}>\n*根拠:* ${proposal.reason}`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*変更前*\n${proposal.oldTitle}` },
            { type: 'mrkdwn', text: `*変更後*\n${proposal.newTitle}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*28日データ:* ${candidate.curr.impressions}表示 / ${candidate.curr.clicks}クリック / CTR ${(candidate.curr.ctr * 100).toFixed(1)}% / ${candidate.curr.position.toFixed(1)}位\n*関連語句:* ${queries.length ? queries.join(' / ') : '十分なデータなし'}\n<${pull.html_url}|GitHubで差分を見る>`,
          },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: 'このメッセージに ✅ で本番反映、❌ で見送り。変更はタイトル1行だけです。',
          }],
        },
      ],
    });
  } catch (error) {
    await githubRequest(`/pulls/${pull.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    }).catch(() => {});
    throw error;
  }

  return { status: 'created', path, pullNumber: pull.number, pullUrl: pull.html_url, proposal };
}

function proposalPathFromBody(body) {
  const match = String(body || '').match(/<!-- seo-file:([^\n]+) -->/);
  return match?.[1]?.trim() || null;
}

async function waitForBuild(headSha) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const data = await githubRequest(`/commits/${headSha}/check-runs?per_page=50`);
    const builds = (data.check_runs || []).filter((run) => run.name === 'build');
    if (builds.some((run) => run.status === 'completed' && run.conclusion === 'success')) return;
    if (builds.some((run) => run.status === 'completed' && !['success', 'skipped', 'neutral'].includes(run.conclusion))) {
      throw new Error('GitHubのビルドチェックが失敗したため公開しませんでした');
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('GitHubのビルド確認が時間内に完了しませんでした');
}

export async function approveSeoPullRequest(prNumber) {
  const { repo } = githubConfig();
  const pull = await githubRequest(`/pulls/${prNumber}`);
  if (pull.merged) return { status: 'already_merged', url: pull.html_url };
  if (pull.state !== 'open') throw new Error('このSEO提案はすでに終了しています');
  if (pull.base?.ref !== 'main' || pull.head?.repo?.full_name !== repo) throw new Error('承認対象外のPRです');
  if (!pull.body?.includes('<!-- seo-approval-flow:v1 -->')) throw new Error('承認フロー外のPRです');

  const path = proposalPathFromBody(pull.body);
  if (!path?.startsWith('src/content/blog/') || !path.endsWith('.md')) throw new Error('対象ファイルが不正です');
  const files = await githubRequest(`/pulls/${prNumber}/files?per_page=100`);
  if (files.length !== 1 || files[0].filename !== path) throw new Error('タイトル以外のファイル変更が含まれています');

  const [before, after] = await Promise.all([
    getGithubFile(path, pull.base.sha),
    getGithubFile(path, pull.head.sha),
  ]);
  const titles = validateOnlyTitleChanged(before.content, after.content);
  await waitForBuild(pull.head.sha);

  const merged = await githubRequest(`/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({
      sha: pull.head.sha,
      merge_method: 'squash',
      commit_title: `seo: approve title update for ${path.split('/').pop()}`,
    }),
  });
  if (!merged.merged) throw new Error(merged.message || 'PRをマージできませんでした');
  return { status: 'merged', url: pull.html_url, path, ...titles };
}

export async function rejectSeoPullRequest(prNumber) {
  const pull = await githubRequest(`/pulls/${prNumber}`);
  if (pull.merged) throw new Error('すでに公開済みの提案は見送りにできません');
  if (pull.state === 'closed') return { status: 'already_closed', url: pull.html_url };
  if (!pull.body?.includes('<!-- seo-approval-flow:v1 -->')) throw new Error('承認フロー外のPRです');
  await githubRequest(`/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  return { status: 'closed', url: pull.html_url };
}
