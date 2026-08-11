import { waitUntil } from '@vercel/functions';
import {
  approveSeoPullRequest,
  getSlackMessage,
  postSlackBotMessage,
  prNumberFromSlackMessage,
  rejectSeoPullRequest,
  verifySlackSignature,
} from '../lib/seo-automation.js';

const APPROVE_REACTION = 'white_check_mark';
const REJECT_REACTION = 'x';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function approverIds() {
  return new Set(
    (process.env.SLACK_APPROVER_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function handleReaction(event) {
  const channel = process.env.SLACK_CHANNEL_ID?.trim();
  if (!channel || event.item?.type !== 'message' || event.item.channel !== channel) return;
  if (!approverIds().has(event.user)) return;
  if (![APPROVE_REACTION, REJECT_REACTION].includes(event.reaction)) return;

  const message = await getSlackMessage(channel, event.item.ts);
  const prNumber = prNumberFromSlackMessage(message);
  if (!prNumber) return;

  try {
    if (event.reaction === APPROVE_REACTION) {
      await postSlackBotMessage({
        threadTs: event.item.ts,
        text: '✅ 承認を受け付けました。ビルドと変更範囲を確認しています。',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: '✅ 承認を受け付けました。ビルドと変更範囲を確認しています。' },
        }],
      });
      const result = await approveSeoPullRequest(prNumber);
      const text = result.status === 'already_merged'
        ? `✅ この提案はすでに公開済みです。\n<${result.url}|GitHubで確認>`
        : `🚀 *本番反映を開始しました*\n*変更前:* ${result.oldTitle}\n*変更後:* ${result.newTitle}\n<${result.url}|GitHubの記録>｜<https://tsuyoshishirota.com|サイトを開く>`;
      await postSlackBotMessage({
        threadTs: event.item.ts,
        text: 'SEO提案を承認し、本番反映を開始しました。',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
      return;
    }

    const result = await rejectSeoPullRequest(prNumber);
    await postSlackBotMessage({
      threadTs: event.item.ts,
      text: '❌ このSEO提案は見送りにしました。サイトは変更していません。',
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ このSEO提案は見送りにしました。サイトは変更していません。\n<${result.url}|GitHubの記録>`,
        },
      }],
    });
  } catch (error) {
    console.error('slack seo approval:', error.message, error.stack);
    await postSlackBotMessage({
      threadTs: event.item.ts,
      text: `SEO承認処理に失敗しました: ${error.message}`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *変更は公開されませんでした*\n${error.message}\n安全確認が必要なため処理を停止しました。`,
        },
      }],
    }).catch(() => {});
  }
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    const rawBody = await request.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
    // 初回App作成時のURL確認だけは無害なchallenge応答を許可する。
    // Signing Secret設定後はURL確認を含む全リクエストを署名検証する。
    if (!signingSecret && body.type === 'url_verification' && body.challenge) {
      return json({ challenge: body.challenge });
    }
    if (!signingSecret || !verifySlackSignature(rawBody, request.headers, signingSecret)) {
      return json({ error: 'Invalid Slack signature' }, 401);
    }
    if (body.type === 'url_verification') return json({ challenge: body.challenge });
    if (body.type !== 'event_callback' || body.event?.type !== 'reaction_added') return json({ ok: true });

    waitUntil(handleReaction(body.event));
    return json({ ok: true });
  },
};
