import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dashboard build.
 *
 * `base: './'` keeps the bundle portable: the same `dist/` works on GitHub
 * Pages, behind a path prefix, or served by the relay itself.
 *
 * In development the relay is proxied from the same origin so the browser never
 * calls a loopback address directly (the deployed bundle cannot see the
 * developer's machine). `VITE_RELAY_URL` overrides the API base for a
 * deployment where the relay lives on a different origin.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devRelay = env.VITE_DEV_RELAY ?? 'http://127.0.0.1:8787';

  return {
    base: './',
    plugins: [react()],
    build: {
      outDir: 'dist',
      sourcemap: false,
      target: 'es2022',
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: false,
      proxy:
        env.VITE_RELAY_URL && env.VITE_RELAY_URL.length > 0
          ? undefined
          : {
              '/api': { target: devRelay, changeOrigin: true },
              '/health': { target: devRelay, changeOrigin: true },
              '/ready': { target: devRelay, changeOrigin: true },
            },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
    },
  };
});
