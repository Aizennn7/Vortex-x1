# Permanent VORTEX scan trigger

The public dashboard never receives a GitHub credential. The Supabase Edge Function verifies Cloudflare Turnstile and then dispatches the existing `vortex-jobs.yml` **cycle** workflow. VIP and Session currently select separate UI controls but use the same engine cycle; no separate strategies or entitlement system are implied.

## One-time configuration

1. Create a Cloudflare Turnstile widget for hostname `aizennn7.github.io`; keep its secret key private.
2. Deploy `supabase/functions/scan-trigger/index.ts` to your existing Supabase project.
3. Set Edge Function secrets:
   - `GITHUB_ACTIONS_TOKEN`: fine-grained GitHub token restricted to repository `Aizennn7/Vortex-x1`, with Actions: write.
   - `TURNSTILE_SECRET_KEY`: the Turnstile secret.
   - `TURNSTILE_HOSTNAME`: `aizennn7.github.io`.
4. Set GitHub repository Actions variable `VITE_SCAN_TRIGGER_URL` to the deployed function URL.
5. Set `VITE_TURNSTILE_SITE_KEY` to the Turnstile **site** key and rebuild GitHub Pages.

Never put either secret in GitHub Pages variables, source code, or the browser bundle. The function rejects requests without a valid Turnstile token. Apply Supabase platform-level rate limits/WAF rules as additional abuse protection.

## Important current limitation

The dashboard scan buttons need a valid Turnstile response token. Until the Turnstile widget is rendered in the dashboard and the site key is configured, the endpoint intentionally rejects requests. Do not expose the function without Turnstile verification. GitHub Actions cron runs are scheduled at five-minute intervals on the configured market days, but GitHub can delay scheduled runs and a scan may correctly publish zero signals.
