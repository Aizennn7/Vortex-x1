import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Dashboard build.
 *
 * `base` defaults to `'./'`, which keeps the bundle portable: the same `dist/`
 * works on GitHub Pages under `https://<owner>.github.io/<repo>/`, behind any
 * path prefix, or served by the relay itself. Set `VITE_BASE_PATH=/` only if
 * the site is later served from a domain root (custom domain / user site) —
 * a wrong base is the classic "blank page on GitHub Pages" failure.
 *
 * In development the relay is proxied from the same origin so the browser never
 * calls a loopback address directly (the deployed bundle cannot see the
 * developer's machine). `VITE_RELAY_URL` overrides the API base for a
 * deployment where the relay lives on a different origin — on GitHub Pages it
 * must, because the relay URL is only known once the relay is deployed.
 *
 * `VITE_DEV_ALLOWED_HOSTS` is an explicit opt-in for serving the dev server
 * through a tunnel, container hostname or hosted preview. Vite rejects unknown
 * `Host` headers by default; listing them here keeps that protection on for
 * every other host. Leave it empty for normal local development.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Vite only forwards VITE_-prefixed variables from the real process
  // environment when they are read through loadEnv's file system; mirror the
  // ones we depend on explicitly so CI can supply them as plain env vars.
  const relayUrl = process.env.VITE_RELAY_URL ?? env.VITE_RELAY_URL ?? '';
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '';
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '';
  const dataSource = process.env.VITE_DATA_SOURCE ?? env.VITE_DATA_SOURCE ?? '';
  const base = (process.env.VITE_BASE_PATH ?? env.VITE_BASE_PATH ?? './').trim() || './';
  const devRelay = env.VITE_DEV_RELAY ?? 'http://127.0.0.1:8787';
  const allowedHosts = (process.env.VITE_DEV_ALLOWED_HOSTS ?? env.VITE_DEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  // Hard build-time guard: never allow a Supabase service_role or secret key
  // to be passed as VITE_SUPABASE_ANON_KEY.
  if (supabaseAnonKey) {
    if (/service_role/i.test(supabaseAnonKey) || /^sb_secret_/i.test(supabaseAnonKey.trim())) {
      throw new Error('Refusing to build: VITE_SUPABASE_ANON_KEY contains a privileged service_role / secret key.');
    }
    const jwtParts = supabaseAnonKey.trim().split('.');
    if (jwtParts.length === 3 && jwtParts[1]) {
      try {
        const decoded = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8')) as { role?: string };
        if (decoded.role && decoded.role !== 'anon') {
          throw new Error(
            `Refusing to build: VITE_SUPABASE_ANON_KEY JWT has role="${decoded.role}" (only role="anon" is permitted in browser code).`,
          );
        }
      } catch (err) {
        if ((err as Error).message.startsWith('Refusing to build')) throw err;
      }
    }
  }

  return {
    base,
    define: {
      // Build-time constants: explicit `define` entries win over Vite's own
      // env replacement and keep the value visible in the bundle for auditing.
      'import.meta.env.VITE_RELAY_URL': JSON.stringify(relayUrl.replace(/\/+$/, '')),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl.replace(/\/+$/, '')),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey.trim()),
      'import.meta.env.VITE_DATA_SOURCE': JSON.stringify(dataSource.trim()),
      'import.meta.env.VITE_BASE_PATH': JSON.stringify(base),
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(process.cwd(), 'index.html'), signals: resolve(process.cwd(), 'signals.html'), history: resolve(process.cwd(), 'signal-history.html'), markets: resolve(process.cwd(), 'markets.html'), learning: resolve(process.cwd(), 'learning.html'), secrets: resolve(process.cwd(), 'secrets.html'), instructions: resolve(process.cwd(), 'instructions.html'), delivery: resolve(process.cwd(), 'delivery.html'), performance: resolve(process.cwd(), 'performance.html'), system: resolve(process.cwd(), 'system.html'), settings: resolve(process.cwd(), 'settings.html'), integrations: resolve(process.cwd(), 'integrations.html'), operator: resolve(process.cwd(), 'operator.html') } },
      outDir: 'dist',
      sourcemap: false,
      target: 'es2022',
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: false,
      // `undefined` keeps Vite's default host check exactly as it is.
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
      proxy:
        relayUrl.length > 0
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