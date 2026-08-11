export const SITE_ORIGIN = 'https://tsuyoshishirota.com';
export const OWNER_NAME = '城田 剛';
export const HOME_META_TITLE = '小さなお店のAI自動化｜城田 剛';
export const HOME_META_DESCRIPTION = '売上集計、データ転記、月次レポート。カフェやジムなど、小さなお店で毎月繰り返す手作業をAIで自動化します。';
export const BLOG_INDEX_META_TITLE = 'サウナブログ｜城田 剛';
export const BLOG_INDEX_META_DESCRIPTION = '国内外のサウナ施設について、料金・アクセス・設備・利用体験を紹介する城田剛のサウナブログです。';
export const DEFAULT_OG_IMAGE = '/images/tsuyoshi-shirota.jpg';

export function normalizeMetaText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function buildMetaTitle(pageTitle, suffix = OWNER_NAME, maxLength = 70) {
  const title = normalizeMetaText(pageTitle);
  const normalizedSuffix = normalizeMetaText(suffix);
  if (!title) return HOME_META_TITLE;
  if (!normalizedSuffix || title === normalizedSuffix || title.endsWith(`｜${normalizedSuffix}`)) {
    return title.slice(0, maxLength);
  }
  const combined = `${title}｜${normalizedSuffix}`;
  return combined.length <= maxLength ? combined : title.slice(0, maxLength);
}

export function normalizeMetaDescription(value, maxLength = 160) {
  const description = normalizeMetaText(value);
  if (description.length <= maxLength) return description;
  return `${description.slice(0, maxLength - 1).replace(/[、。,.\s]+$/u, '')}…`;
}

export function imageMimeType(imagePath) {
  const cleanPath = String(imagePath || '').split('?')[0].toLowerCase();
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.webp')) return 'image/webp';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

export function buildSaunaDraftTitle(saunaName) {
  return `${normalizeMetaText(saunaName) || 'サウナ施設'}｜サウナ・水風呂・外気浴の体験レビュー`;
}
