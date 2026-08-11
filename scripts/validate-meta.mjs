import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_DIR = new URL('../dist/', import.meta.url);
const DIST_PATH = fileURLToPath(DIST_DIR);
const SITE_ORIGIN = 'https://tsuyoshishirota.com';

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const fullPath = path.join(fileURLToPath(directory), entry.name);
    return entry.isDirectory()
      ? findHtmlFiles(new URL(`${entry.name}/`, directory))
      : entry.name.endsWith('.html') ? [fullPath] : [];
  }));
  return files.flat();
}

function tags(html, name) {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
}

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, 'i'));
  return decodeHtml(match?.[1] || '');
}

function metaContent(html, selector, value) {
  const matching = tags(html, 'meta').filter((tag) => attribute(tag, selector) === value);
  assert.equal(matching.length, 1, `meta ${selector}="${value}" must appear exactly once`);
  return attribute(matching[0], 'content');
}

function canonicalUrl(html) {
  const matching = tags(html, 'link').filter((tag) => attribute(tag, 'rel') === 'canonical');
  assert.equal(matching.length, 1, 'canonical must appear exactly once');
  return attribute(matching[0], 'href');
}

function pageLabel(file) {
  return path.relative(DIST_PATH, file);
}

function validatePublicPage(html, file) {
  const titleMatches = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)];
  assert.equal(titleMatches.length, 1, 'title must appear exactly once');

  const title = decodeHtml(titleMatches[0][1].trim());
  const description = metaContent(html, 'name', 'description');
  const robots = metaContent(html, 'name', 'robots');
  const canonical = canonicalUrl(html);
  const ogTitle = metaContent(html, 'property', 'og:title');
  const ogDescription = metaContent(html, 'property', 'og:description');
  const ogUrl = metaContent(html, 'property', 'og:url');
  const ogImage = metaContent(html, 'property', 'og:image');
  const twitterTitle = metaContent(html, 'name', 'twitter:title');
  const twitterDescription = metaContent(html, 'name', 'twitter:description');
  const twitterImage = metaContent(html, 'name', 'twitter:image');

  assert.ok(title.length > 0 && title.length <= 70, 'title must be 1-70 characters');
  assert.ok(description.length > 0 && description.length <= 160, 'description must be 1-160 characters');
  assert.match(robots, /\b(?:index|noindex)\b/i, 'robots must declare index or noindex');
  assert.ok(canonical.startsWith(SITE_ORIGIN), 'canonical must use the production origin');
  assert.ok(canonical === `${SITE_ORIGIN}/` || !canonical.endsWith('/'), 'only the home canonical may end with /');
  assert.equal(ogTitle, title, 'og:title must match title');
  assert.equal(ogDescription, description, 'og:description must match description');
  assert.equal(ogUrl, canonical, 'og:url must match canonical');
  assert.equal(twitterTitle, title, 'twitter:title must match title');
  assert.equal(twitterDescription, description, 'twitter:description must match description');
  assert.equal(twitterImage, ogImage, 'Twitter and Open Graph images must match');
  assert.ok(ogImage.startsWith(`${SITE_ORIGIN}/`), 'social image must be an absolute production URL');
  assert.match(html, /<script\s+type=["']application\/ld\+json["']>/i, 'structured data is required');

  return { title, canonical };
}

const files = await findHtmlFiles(DIST_DIR);
const results = [];

for (const file of files) {
  const html = await readFile(file, 'utf8');
  const label = pageLabel(file);

  try {
    if (label === 'admin/index.html') {
      assert.match(metaContent(html, 'name', 'robots'), /\bnoindex\b/i, 'admin must be noindex');
      continue;
    }
    results.push(validatePublicPage(html, file));
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

assert.ok(results.length > 0, 'no public HTML pages found');
assert.equal(new Set(results.map(({ canonical }) => canonical)).size, results.length, 'canonical URLs must be unique');

console.log(`Validated metadata for ${results.length} public pages (${files.length} HTML pages total).`);
