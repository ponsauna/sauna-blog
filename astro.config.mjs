import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

const noindexPaths = new Set([
  '/admin',
  '/blog/2026-04-26-paradise-大手町',
  '/blog/九州サウナ-おすすめ-5選',
]);

function normalizedPath(page) {
  const pathname = decodeURIComponent(new URL(page).pathname);
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
}

export default defineConfig({
  site: 'https://tsuyoshishirota.com',
  trailingSlash: 'never',
  integrations: [
    tailwind(),
    sitemap({
      filter: (page) => !noindexPaths.has(normalizedPath(page)),
      serialize: (item) => ({
        ...item,
        url: item.url === 'https://tsuyoshishirota.com/'
          ? item.url
          : item.url.replace(/\/+$/, ''),
      }),
    }),
  ],
});
