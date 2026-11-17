import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Strict CSP for packaged builds only (the dev server needs inline scripts for React Fast Refresh). */
const csp: Plugin = {
  name: 'terminaltab-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
      },
      injectTo: 'head-prepend',
    },
  ],
};

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), csp],
  define: { APP_VERSION: JSON.stringify(version) },
});
