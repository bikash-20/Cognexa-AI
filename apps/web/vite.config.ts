import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (!env.VITE_API_BASE) {
    // Hard fail per Imperative #8 — never discover missing env in production.
    throw new Error('[build] VITE_API_BASE is required. Set it in apps/web/.env');
  }
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['orb.jpg'],
        manifest: {
        name: 'Cognexa AI',
        short_name: 'Cognexa',
        description: 'Cognexa AI — glass-morphic assistant.',
        theme_color: '#f3a8c2',
        background_color: '#1a0a12',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'orb.jpg', sizes: '512x512', type: 'image/jpeg', purpose: 'any maskable' }
        ]
      },
        workbox: {
          runtimeCaching: [
            {
              urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkFirst',
              options: { cacheName: 'api-cache', networkTimeoutSeconds: 4 }
            }
          ]
        }
      })
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { host: true, port: 5173 },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            markdown: ['marked', 'katex', 'react-katex', 'shiki']
          }
        }
      }
    }
  };
});
