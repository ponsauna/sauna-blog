import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  frontmatterValue,
  prNumberFromSlackMessage,
  replaceFrontmatterValue,
  validateOnlyTitleChanged,
  validateProposedTitle,
  verifySlackSignature,
} from '../lib/seo-automation.js';

const article = `---
title: "サウナ施設の利用体験"
date: 2025-01-01
excerpt: "施設の設備と利用時の感想を紹介します。"
---

本文には駅から徒歩5分と書かれています。
`;

test('titleだけを安全に置換できる', () => {
  const changed = replaceFrontmatterValue(article, 'title', 'サウナ施設の設備・アクセス・利用体験');
  assert.equal(frontmatterValue(changed, 'title'), 'サウナ施設の設備・アクセス・利用体験');
  assert.deepEqual(validateOnlyTitleChanged(article, changed), {
    oldTitle: 'サウナ施設の利用体験',
    newTitle: 'サウナ施設の設備・アクセス・利用体験',
  });
});

test('タイトル以外の変更を拒否する', () => {
  const changed = replaceFrontmatterValue(article, 'title', 'サウナ施設の設備・アクセス・利用体験')
    .replace('徒歩5分', '徒歩3分');
  assert.throws(() => validateOnlyTitleChanged(article, changed), /承認対象外/);
});

test('誇張表現・年号・本文にない数値を拒否する', () => {
  assert.throws(() => validateProposedTitle('現在のタイトルです', '2026年最新サウナ完全ガイド', article));
  assert.throws(() => validateProposedTitle('現在のタイトルです', 'サウナ施設への徒歩3分アクセス情報', article));
});

test('Slack署名を検証する', () => {
  const secret = 'test-signing-secret';
  const timestamp = '1700000000';
  const rawBody = '{"type":"event_callback"}';
  const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const headers = new Headers({
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
  });
  assert.equal(verifySlackSignature(rawBody, headers, secret, 1700000000 * 1000), true);
  assert.equal(verifySlackSignature(`${rawBody}x`, headers, secret, 1700000000 * 1000), false);
});

test('Slackメッセージから承認対象PR番号を取得する', () => {
  assert.equal(prNumberFromSlackMessage({ blocks: [{ block_id: 'seo_pr_42' }] }), 42);
  assert.equal(prNumberFromSlackMessage({ blocks: [{ block_id: 'other' }] }), null);
});
